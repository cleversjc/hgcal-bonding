Previous development UI: 2026-11-04 one-tap completion release.
Source commit: 7655f512f86764506a051b51defd486245676e09
Pinned tag: dev-before-field-workflow-20261106

This snapshot retains the original v1 database name. The new root app uses a
separate database and copies records here only after an explicit version-return
action. Use the root app's “带当前记录回到上一版” action to carry current records.
The banner link hands later legacy edits back to the new app via IndexedDB.

App/mapping/reference assets remain byte-identical to the pinned source.
Runtime adaptations are limited to independent service-worker/installation
identifiers, the return banner/bridge, and scoped-report backup compatibility
in storage.js/ogp.js. See source-manifest.json for original file hashes.

The root shell also caches this snapshot, allowing a first offline return before
the dedicated snapshot worker installs. stable-v1 is a separate, unchanged app.
