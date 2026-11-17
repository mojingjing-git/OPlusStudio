# O+ Studio native workspace

The desktop configuration task drives the layout. A fixed left navigation, six rear slots and a single contextual editor follow the researched 0.4 workflow. A small vector controller is the one identifying visual; it selects the same slots as the keyboard-accessible cards and is explicitly a schematic, not a photograph of hardware placement.

Tokens: paper `#f1f4f6`, surface `#ffffff`, graphite `#202c37`, slate `#596a78`, configuration green `#176958`, navigation `#192832`. Amber indicates drafts. Segoe UI Variable and Microsoft YaHei UI use system font rendering; timings use tabular numbers and raw details use Cascadia Code / Consolas.

The generic marketing Hero/CTA pattern returned by the design-system search was rejected as unsuitable for a desktop utility. The narrower search verified keyboard navigation and unobscured fixed navigation guidance. Product-specific choices are six persistent slots, direct multi-key selection, a structured macro table, readback state, a deliberate save summary, and a visible recovery center. No promotional dashboard statistics or decorative gradients are used.

The UI uses CSS logical pixels, SVG and native WebView2 per-monitor scaling. It offers independent 100/115/130/150% text sizing, dark mode, scrolling within the workspace, and a stacked editor at smaller logical widths. Dialogs use the native HTML dialog focus boundary, visible labels and Escape cancellation. Ctrl+S saves and Ctrl+R reads; hardware changes always stay behind the Rust backend's typed operation boundary.
