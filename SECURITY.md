# Security

Ouroboros handles a hot wallet and API keys, so security reports matter. Please report a vulnerability privately through GitHub's security advisory form for this repository and do not open a public issue.

Useful reports include a way for the agent or a fetched web page to read the vault, bypass the egress firewall, raise the budget limits, change the Charter without detection, or make the audit log verify after tampering. Include the release, the steps to reproduce and the effect.

The threat model is written down in section 8 of [docs/SYSTEM.md](docs/SYSTEM.md). In short, the agent has root inside its VM, so the limits that hold are the amount funded, the key scopes, the VM boundary and the operator's off-switch. Everything inside the VM is a tripwire and not a wall.
