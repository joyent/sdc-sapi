# sdc-sapi changelog

# 2.1.1

- TRITON-1035, TRITON-1203: Fixing the SAPI test suite to work when there
  are mockcloud CNs in play.

# 2.1.0

- SAPI-294 This is a significant change to SAPI zone setup and config handling.
  (There is no change to its API.) SAPI zone setup has changed to no longer
  depend on SAPI via depending on config-agent to create its config file.
  This will simplify `sdcadm up sapi`.

# 2.0.0

The version when this changelog was started.
