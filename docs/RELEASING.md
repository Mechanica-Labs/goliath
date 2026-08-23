# Public release

The primary installer is npm because Goliath already requires Node.js, while `goliath setup` installs the matching Camoufox browser engine without relying on npm lifecycle scripts. A Homebrew tap can be added after the first tagged release, but it should consume the same immutable npm or GitHub release artifact rather than introduce a second installation system.

## One-time npm setup

1. Confirm the release owner can publish `@mechanica-labs/goliath`.
2. Configure npm trusted publishing for GitHub Actions:
   - package: `@mechanica-labs/goliath`
   - repository: `Mechanica-Labs/goliath`
   - workflow file: `publish.yml`
   - permission: publish
   - environment: blank, unless the workflow is later changed to use one
3. Keep GitHub environment protection or required reviewers on release creation if the repository policy requires it.

The workflow authenticates through npm trusted publishing and publishes with npm provenance. Do not commit npm tokens, `.npmrc`, auth URLs, trusted-publisher record IDs, or account access records to this repo. Goliath declares npm's dual-use metadata because browser fingerprint controls and page evaluation can resemble security tooling.

## Release

```bash
npm version patch
git push --follow-tags
```

Create and publish the matching GitHub Release, or run the publish workflow manually from the public `Mechanica-Labs/goliath` repository. The workflow installs dependencies, then `prepublishOnly` runs the build, OpenAPI generation, and complete test suite before npm uploads a provenance-attested public package.

Verify the user path from a clean shell:

```bash
npm view @mechanica-labs/goliath version
npx -y @mechanica-labs/goliath@VERSION --version
npx -y @mechanica-labs/goliath@VERSION doctor
npx -y @mechanica-labs/goliath@VERSION setup --hermes
```

Run `npm run test:mcp` on a machine with the Camoufox engine installed to verify a real stdio MCP initialize/list/call exchange and live page snapshot.

## Homebrew follow-up

Create `Mechanica-Labs/homebrew-tap` only after a stable GitHub tag and npm package exist. The formula should use a checksummed, immutable release artifact and Homebrew's Node package installation helpers. Until then, npm is both shorter for users and less likely to drift from the browser runtime Goliath actually ships.
