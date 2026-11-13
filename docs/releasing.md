# Releasing

Publishing a GitHub Release triggers `.github/workflows/publish.yml` in the
repository. Its tag must be `v` followed by the version in `package.json`, for
example `v0.1.0`.
GitHub's **Set as a pre-release** choice sends the package to npm's `next` tag;
other published releases use `latest`. Draft releases do not publish anything.

The workflow does not choose or bump versions, create releases, register npm
packages, or change repository visibility. The repository/account owner performs
the setup below when ready for the first public release.

## Before the first automated release

1. Choose the package version and intended license, and remove `private: true`
   from `package.json` when ready to publish. Keep `package-lock.json` in sync with
   version or dependency changes.
2. Make the GitHub repository public before publishing the release. Release
   events from private repositories fail before npm publication. Keep
   `package.json`'s `repository.url` matched to this GitHub repository.
3. Register the package under the intended npm account. Initial registration is a
   separate account-owner action. [Staging a new package](https://docs.npmjs.com/staged-publishing)
   creates a public placeholder even before its first full version is approved;
   do not do this until ready to expose that metadata.
4. In the npm package's **Trusted Publisher** settings, select GitHub Actions and
   enter this repository's GitHub owner and name. Set the workflow filename to
   **`publish.yml`**, not its full path, allow direct `npm publish`, and leave the
   environment name empty. Trusted publishing needs no long-lived npm token
   stored as a GitHub secret.

Create the trusted-publisher configuration close to the first automated publish:
npm requires a new configuration to complete its first successful publish within
two days. See [npm's trusted-publishing instructions](https://docs.npmjs.com/trusted-publishers/)
for setup and expiry details.

## Publish a version

Commit the intended package version, lockfile and release documentation before
creating its tag. The tagged commit must include the workflow. Publish a GitHub
Release for `v<package.json version>`, selecting pre-release when appropriate.

The workflow checks out the release event's immutable commit for both jobs. It
validates release metadata, installs locked dependencies, runs type checking and
tests, and previews the package contents. Only after those checks succeed does a
separate job receive permission to publish using npm's short-lived OIDC identity.

The package ships source and needs no build step. The publishing job does not
install dependencies or run package lifecycle scripts. GitHub-hosted Node.js 24
supplies the npm CLI required for trusted publishing; no long-lived npm token is
stored. npm automatically adds provenance for public packages published this way
from public GitHub repositories.

## Failures and retries

A failed npm publish leaves the GitHub Release in place and the workflow marked
as failed. Publishing is not atomic across the two services, and the workflow
does not roll back either release or unpublish npm versions.

Fix the reported cause before rerunning a failed job. If npm accepted a version
before the job failed, that version cannot be overwritten; check the registry
before retrying. The workflow does not silently treat an existing version as a
successful publish.
