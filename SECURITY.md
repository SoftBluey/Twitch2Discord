# Security

Never commit your real config, token, logs containing credentials, or signed
media URLs. If a token is exposed, revoke it. Use GitHub's private vulnerability
reporting when available; do not post sensitive details in public issues.

Run `npm audit` when updating dependencies. A clean audit does not guarantee
that the application or its dependencies are free of vulnerabilities.

The `ip` override uses `neoip@2.1.0`, matching node-av's own upstream override.
Overrides declared by dependencies are not applied automatically by npm, so
this project applies it at the root to fix the old address-classification flaw.
Do not remove it without checking the replacement dependency tree.

A normal user account limits the impact of a compromised dependency. It is
optional: the system-service installer also supports running as root, with root
permissions. Native dependency install scripts are required; approvals are pinned
to the versions in the lockfile. Review dependency updates before installing them.
The Discord account-policy limitation is covered in the README.
