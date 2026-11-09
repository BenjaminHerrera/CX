# Bundled terminal libraries

SSH screen rendering uses these unmodified pure Python library sources:

| Library | Version | Upstream | License |
|---|---|---|---|
| pyte | 0.8.2 | https://github.com/selectel/pyte | LGPL v3 (see retained license) |
| wcwidth | 0.9.4 | https://github.com/jquast/wcwidth | MIT; retained notices |

Only Python source is bundled; optional compiled extensions, caches, and
installed distribution metadata are omitted. Host Python uses the bundled
modules, so users do not need pip, a package install, or tmux. The original
source files retain their notices. pyte's LGPL and the referenced GPL text
are included as `pyte/LICENSE` and `pyte/COPYING`; wcwidth's license is in
`wcwidth/LICENSE`.

The source copies came from the corresponding conda-forge Python packages.
Wrapper integration and screen handling are in `bin/cx_screen.py`; the
libraries themselves are unmodified and replaceable independently. To update,
copy the new pure Python sources and notices, update this version table and
the release file list, and run the offline screen and bridge suites. Release
manifests cover each bundled file. The wrapper's own distribution license
remains a separate source-owner decision.
