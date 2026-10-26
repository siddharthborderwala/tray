# Security

Please report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on
[siddharthborderwala/tray](https://github.com/siddharthborderwala/tray/security/advisories/new).

Please don't open a public issue. I'll reply within a few days.

Releases are built in GitHub Actions with build provenance. To verify a binary:

```sh
gh attestation verify tray-darwin-arm64.tar.gz --repo siddharthborderwala/tray
```
