/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * test/helper.js: setup test environment
 */

var assert = require('assert-plus');
var async = require('async');
var bunyan = require('bunyan');
var common = require('./common');
var fs = require('fs');
var once = require('once');
var path = require('path');
var sdc = require('sdc-clients');
var restify = require('restify');
var util = require('util');

var SAPI = require('../lib/server/sapi');
var VMAPIPlus = require('../lib/server/vmapiplus');
var loadConfig = require('../lib/config').loadConfig;

var exec = require('child_process').exec;

var SAPI_TEST_SERVER_PORT = 12345;
var SAPI_TEST_METRICS_SERVER_PORT = 8882;

// -- Helpers

function createLogger(name, stream) {
    var log = bunyan.createLogger({
        level: (process.env.LOG_LEVEL || 'warn'),
        name: name || process.argv[1],
        stream: stream || process.stdout,
        src: true,
        serializers: restify.bunyan.serializers
    });
    return (log);
}

function createJsonClient(opts) {
    var log = createLogger();
    var client = restify.createJsonClient({
        agent: false,
        connectTimeout: 250,
        log: log,
        retry: false,
        type: 'http',
        url: process.env.SAPI_URL || 'http://localhost:' +
            SAPI_TEST_SERVER_PORT,
        version: (opts && opts.version) ? opts.version : '*'
    });

    return (client);
}

function createSapiClient(opts) {
    var log = createLogger();
    var client = new sdc.SAPI({
        agent: false,
        log: log,
        url: process.env.SAPI_URL || 'http://localhost:' +
            SAPI_TEST_SERVER_PORT,
        version: (opts && opts.version) ? opts.version : '*'
    });

    return (client);
}

function createVmapiClient(vmapiUrl) {
    assert.optionalString(vmapiUrl);

    var log = createLogger();

    var client = new sdc.VMAPI({
        agent: false,
        log: log,
        url: vmapiUrl || process.env.VMAPI_URL || 'http://10.2.206.23'
    });

    return (client);
}


function createVmapiPlusClient() {
    var log = createLogger();

    var vmapi = new sdc.VMAPI({
        agent: false,
        log: log,
        url: process.env.VMAPI_URL || 'http://10.2.206.23'
    });

    var client = new VMAPIPlus({
        log: log,
        vmapi: vmapi
    });

    return (client);
}

function createNapiClient() {
    var log = createLogger();

    var client = new sdc.NAPI({
        agent: false,
        log: log,
        url: process.env.NAPI_URL || 'http://10.2.206.6'
    });

    return (client);
}

function createImgapiClient() {
    var log = createLogger();

    var client = new sdc.IMGAPI({
        agent: false,
        log: log,
        url: process.env.IMGAPI_URL || 'http://10.2.206.17'
    });

    return (client);
}


function createPapiClient() {
    var log = createLogger();

    var client = new sdc.PAPI({
        agent: false,
        log: log,
        url: process.env.PAPI_URL || 'http://10.2.206.29'
    });

    return (client);
}


function getPapiSamplePackages(opts, callback) {
    var papi = createPapiClient();

    papi.list('name=sample-*', {}, function (err, pkgs, count) {
        callback(err, pkgs);
    });
}
function startSapiServer(mode, cb) {
    if (arguments.length === 1) {
        cb = mode;
        mode = null;
    }
    assert.func(cb, 'cb');

    if (mode === 'proto') {
        process.env.TEST_SAPI_PROTO_MODE = 'true';
    } else if (mode === 'full') {
        process.env.TEST_SAPI_PROTO_MODE = undefined;
    }

    var log = bunyan.createLogger({
        name: 'sapitest',
        src: true,
        serializers: restify.bunyan.serializers,
        streams: [
            {
                level: 'debug',
                path: path.join(__dirname, 'tests.log')
            }
        ]
    });

    var config;
    var sapi;

    async.series([
        function createSapiServer(next) {
            loadConfig({log: log}, function (configErr, config_) {
                if (configErr) {
                    next(configErr);
                    return;
                }

                config = config_;
                config.vmapi.agent = false;
                config.cnapi.agent = false;
                config.napi.agent = false;
                config.imgapi.agent = false;
                config.papi.agent = false;
                config.port = SAPI_TEST_SERVER_PORT;
                config.metricsPort = SAPI_TEST_METRICS_SERVER_PORT;
                log.debug({config: config}, 'test config');

                // Some of the tests use other SDC services, so load those URLs
                // into environment variables.
                process.env.VMAPI_URL = config.vmapi.url;
                process.env.NAPI_URL = config.napi.url;
                process.env.IMGAPI_URL = config.imgapi.url;
                process.env.PAPI_URL = config.papi.url;

                sapi = new SAPI(config);
                next();
            });
        },
        function getServerUuid(next) {
            var cmd = '/usr/sbin/mdata-get sdc:server_uuid';
            exec(cmd, function (err, stdout) {
                if (err)
                    return (next(err));
                process.env.SERVER_UUID = stdout.trim();
                next();
            });
        },
        function getPackage(next) {
            getPapiSamplePackages({}, function (err, pkgs) {
                if (err) {
                    return (next(err));
                }

                pkgs.sort(function (a, b) {
                    return a.max_physical_memory < b.max_physical_memory
                        ? -1
                        : (a.max_physical_memory > b.max_physical_memory
                          ? 1
                          : 0);
                });

                assert.ok(pkgs.length, 'found some sample packages');

                process.env.BILLING_ID = pkgs[0].uuid;
                next();
            });
        },
        function setSapiTestImageUuid(next) {
            /*
             * We need a image with which to test SAPI services and instances.
             * We don't want to use this zone's image (the sapi zone), because
             * creating a second SAPI instance could very likely cause
             * troubles. Instead, we'll use SAPI's origin image, which we
             * know will already be installed.
             *
             * This is somewhat lamely "passed" around to tests via an envvar.
             */
            var cmd = 'curl -sf ' +
                config.imgapi.url + '/images/$(mdata-get sdc:image_uuid) ' +
                '| json origin';
            exec(cmd, function (err, stdout) {
                if (err)
                    return (next(err));
                process.env.SAPI_TEST_IMAGE_UUID = stdout.trim();
                next();
            });
        },
        function getAdminUuid(next) {
            var cmd = '/usr/sbin/mdata-get sdc:owner_uuid';
            exec(cmd, function (err, stdout) {
                if (err)
                    return (next(err));
                process.env.ADMIN_UUID = stdout.trim();
                next();
            });
        }
    ], function done(err) {
        if (err) {
            throw (err);
        }
        sapi.start(function () {
            cb(null, sapi);
        });
    });
}

function shutdownSapiServer(sapi, cb) {
    assert.object(sapi, 'sapi');
    assert.func(cb, 'cb');

    sapi.shutdown(cb);
}

/*
 * Create a set of default VM params suitable for passing to
 * SAPI.createInstance() or VMAPI.createVm().
 *
 * If more specific params are required, callers should override those params.
 */
function consVmParams(cb) {
    var params = {};
    params.brand = 'joyent-minimal';
    assert.string(process.env.SAPI_TEST_IMAGE_UUID,
        'process.env.SAPI_TEST_IMAGE_UUID');
    params.image_uuid = process.env.SAPI_TEST_IMAGE_UUID;
    params.owner_uuid = process.env.ADMIN_UUID;
    params.server_uuid = process.env.SERVER_UUID;
    params.ram = 256;
    params.cpu_cap = 100;

    async.waterfall([
        function (subcb) {
            var imgapi = createImgapiClient();

            imgapi.adminImportRemoteImageAndWait(
                params.image_uuid, 'https://updates.joyent.com',
                { skipOwnerCheck: true },
                function (err) {
                if (err && err.name ===
                    'ImageUuidAlreadyExistsError')
                    err = null;
                subcb(err);
            });
        },
        function (subcb) {
            resolveNetwork('admin', process.env.ADMIN_UUID,
            function (err, uuid) {
                if (err)
                    return (subcb(err));
                params.networks = [ { uuid: uuid } ];
                subcb();
            });
        }
    ], function (err) {
        return (cb(err, params));
    });
}

/*
 * Resolve a network name to its NAPI UUID.
 */
function resolveNetwork(name, owner, cb) {
    var napi = createNapiClient();
    napi.listNetworks({ name: name, owner_uuid: owner },
        function (err, networks) {
        if (err)
            return (cb(err));
        return (cb(null, networks[0].uuid));
    });
}




// -- Exports

var num_tests = 0;

module.exports = {
    after: function after(teardown) {
        module.parent.exports.tearDown = function _teardown(callback) {
            try {
                teardown.call(this, callback);
            } catch (e) {
                console.error('after:\n' + e.stack);
                process.exit(1);
            }
        };
    },

    before: function before(setup) {
        module.parent.exports.setUp = function _setup(callback) {
            try {
                setup.call(this, callback);
            } catch (e) {
                console.error('before:\n' + e.stack);
                process.exit(1);
            }
        };
    },

    test: function test(name, tester) {
        num_tests++;

        module.parent.exports[name] = function _(t) {
            var _done = false;
            t.end = once(function end() {
                if (!_done) {
                    _done = true;
                    t.done();
                }
            });

            t.notOk = function notOk(ok, message) {
                return (t.ok(!ok, message));
            };

            tester.call(this, t);
        };
    },

    createLogger: createLogger,

    createJsonClient: createJsonClient,
    createSapiClient: createSapiClient,
    createVmapiClient: createVmapiClient,
    createVmapiPlusClient: createVmapiPlusClient,
    createNapiClient: createNapiClient,
    createImgapiClient: createImgapiClient,
    createPapiClient: createPapiClient,

    startSapiServer: startSapiServer,
    shutdownSapiServer: shutdownSapiServer,
    getPapiSamplePackages: getPapiSamplePackages,

    consVmParams: consVmParams,
    resolveNetwork: resolveNetwork,

    getNumTests: function () {
        return (num_tests);
    }
};
