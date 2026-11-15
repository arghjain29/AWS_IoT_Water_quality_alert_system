# Station Simulator

`simulator.py` runs four software-simulated water monitoring stations. They publish pH, turbidity, TDS and temperature readings to AWS IoT Core over MQTT with TLS, and each station signs in with its own certificate.

```powershell
uv sync                          # one time: creates .venv and installs packages
uv run simulator.py --dry-run    # try it without AWS
uv run simulator.py              # real run (needs certificates, see root README)
uv run pytest                    # tests
```

Type `help` while the simulator runs to see the commands, for example `critical 3 ph`, `disconnect 4`, `restore all` and `demo`.
