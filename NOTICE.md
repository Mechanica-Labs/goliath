THIRD-PARTY NOTICES
===================

Goliath's original source code is licensed under the repository's MIT License.
Third-party packages are not relicensed by Goliath: each remains governed by
its own license. The exact dependency versions are recorded in
`package-lock.json`.

Direct runtime dependencies with material notice requirements include:

1. **camoufox-js 0.12.0** - browser runtime installer and integration.
   * Source: https://github.com/apify/camoufox-js
   * License: MPL-2.0

2. **playwright-core 1.60.0** - browser automation core.
   * Source: https://github.com/microsoft/playwright
   * License: Apache-2.0

3. **prom-client 15.1.3** - Prometheus metrics client.
   * Source: https://github.com/siimon/prom-client
   * License: Apache-2.0

4. **express 4.22.2** - HTTP server framework.
   * Source: https://github.com/expressjs/express
   * License: MIT

5. **swagger-jsdoc 6.3.0** - OpenAPI generation.
   * Source: https://github.com/Surnet/swagger-jsdoc
   * License: MIT

Notable transitive runtime dependencies include:

* **ua-parser-js 1.0.41**, selected with an npm override because the APIs used
  by `camoufox-js` remain compatible with the MIT-licensed 1.x release.
  * Source: https://github.com/faisalman/ua-parser-js
  * License: MIT
* **caniuse-lite 1.0.30001809**.
  * Source: https://github.com/browserslist/caniuse-lite
  * License: CC-BY-4.0

Downstream distributors are responsible for preserving the notices and source
availability required by these licenses. Review the complete locked dependency
graph before redistributing bundled dependencies or browser-runtime artifacts.
