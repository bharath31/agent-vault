# Security Policy

nominee brokers access tokens and gates privileged actions, so we take security
reports seriously and respond quickly.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's [private vulnerability reporting](https://github.com/bharath31/nominee/security/advisories/new)
(Security → Report a vulnerability). If you can't use that, email
**security@nominee.dev** with details and we'll coordinate from there.

Please include:

- the affected package(s) and version(s),
- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- any suggested remediation.

## What to expect

- **Acknowledgement** within 3 business days.
- An initial assessment and severity within 7 days.
- A coordinated fix and release, with credit to you (unless you prefer to remain anonymous).

## Supported versions

The latest published minor of each package receives security fixes. Because the
packages are pre-1.0, please upgrade to the most recent release before reporting.

## Scope notes

- The **core** package (`nominee`) has zero runtime dependencies; report issues in the engine, token cache, approval engine, or audit here.
- Strategy/adapter packages (`nominee-auth0`, `nominee-ai`, `nominee-eve`) wrap third-party SDKs/APIs — issues in nominee's handling of them are in scope; issues in the upstream provider should also be reported to that provider.
- nominee never persists third-party tokens itself; tokens are fetched at call time and cached in memory only. Reports about token handling, leakage in logs/audit, or approval bypass are especially welcome.
