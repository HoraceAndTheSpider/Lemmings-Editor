# Lemmings Amiga HTML5 Editor v0.13

HTML5 editor and campaign inspector for the original Amiga Lemmings data.

## Run

Open `app/index.html` directly in a modern browser. No Node, build step or web server is required.

v0.13 accepts any of these source forms:

- a WHDLoad-style `.lha` / `.lzh` archive containing `Disk.1`, `Disk.2`, etc.;
- the `Disk.1` / `Disk.2` image files directly;
- loose Amiga data files selected together;
- an extracted data folder containing the loose files.

The supplied `Lemmings_v1.5_Image_2089.lha` is supported directly.

## New in v0.13 — LHA and disk-image import

The supplied WHDLoad image archive was reverse engineered as part of this build.

Its LHA contains two 983,040-byte images, `Disk.1` and `Disk.2`. The editor now:

1. reads LHA headers in-browser;
2. decompresses `-lh5-` entries in-browser;
3. recognises the original Lemmings image file table at offset `$3000`;
4. reads its 16-byte records (12-byte filename field + 32-bit big-endian byte length);
5. follows the table's `Reserved` entry to the data area;
6. extracts the listed files, each beginning on the next 1024-byte boundary;
7. feeds those embedded files into the same editor pipeline used for loose data.

For the supplied SPS #2089 WHDLoad image archive, `Disk.2` exposes 146 embedded files. The 40 resources required by the current original-game editor (`Level000`–`Level024`, five `Ground` banks, five `Objects` banks, `oddtable`, and four `special` files) were compared with the previously supplied loose data and match byte-for-byte.

`Disk.1` uses the same table format and contains the executable/presentation side of the game, including `Code`.

## Original-game editor features

- Decodes the original ByteKiller-compressed Amiga level/graphics files in the browser.
- Reconstructs normal and special levels from the original data.
- Loads all 100 physical level records: 80 one-player maps and 20 two-player maps.
- Edits base level properties: release rate, population, rescue target, timer, eight skill counts and title.
- Edits the corresponding 80 `oddtable` property/title records independently.
- Campaign-level editor for Fun / Tricky / Taxing / Mayhem:
  - reassign a campaign slot to another physical map;
  - toggle whether the slot uses its physical map's `oddtable` record;
  - move levels up/down within a group;
  - swap slots between difficulty groups;
  - reorder the four difficulty groups at project level.
- Two-player campaign order is displayed/editable over physical records 80–99.
- Physical map settings: initial screen X, graphics set and special backdrop selector.
- Existing terrain, object and steel entries can be selected on the reconstructed level and dragged.
- Terrain/object/steel entries can be added, deleted and numerically edited.
- Terrain draw flags and object draw flags are exposed.
- Steel areas snap to the native 4-pixel storage grid.
- Full editor-project JSON save/import.
- Writer-side exports:
  - active uncompressed 2048-byte level record;
  - active uncompressed 8192-byte four-level pack;
  - modified 4480-byte `oddtable`;
  - campaign-order JSON.

## Writer validation

The level writer has been round-tripped against all 100 supplied physical level records. With no edits, parse -> write reproduces all 100 original 2048-byte records byte-for-byte. The `oddtable` writer likewise reproduces the supplied 4480-byte file byte-for-byte.

The editor preserves source slot positions for terrain, objects and steel. It also preserves two observed terrain-record bits that lie outside the currently decoded terrain ID/X/Y/draw-flag fields, so untouched records are not normalised destructively during export.

## Current playback/export boundary

The editor can now **read** both major WHDLoad packaging styles, but it does not yet produce a complete playable replacement package.

The current WHDLoad Lemmings v1.5 installer supports either disk images or real files, and its own documentation recommends the real-files install because the game can load files directly instead of repeatedly reading sectors from a disk image. This makes a real-files WHDLoad installation the most attractive first playback target once the editor can emit compatible packed level files.

`Level###` source files are ByteKiller-compressed. v0.13 still exports edited level records/packs uncompressed as writer-validation outputs. A compatible packer is therefore the next requirement for drop-in level replacement.

The disk-image format is also now sufficiently understood for a later rebuild path: the filename/size table can be rewritten and the payload files laid back out sequentially on 1024-byte boundaries. That should allow a regenerated `Disk.2` after compatible compression is available, while preserving an untouched `Disk.1` where possible.

Campaign order and difficulty-group order are currently project/export data. The Amiga-native runtime tables which must be patched to make changed order boot directly in the original executable remain to be located/proved.

## Demos and expansions

The importer is intentionally package-oriented rather than hard-wired to one LHA filename. It will enumerate recognised Lemmings disk-image tables and embedded files even when the package is not the original full game.

The editor's current campaign model, however, still expects the original game's 25 `Level###` packs, five normal graphics sets, 80 `oddtable` records and four special backdrops. A demo, X-Mas Lemmings, Holiday Lemmings or Oh No! More Lemmings package will therefore be detected as a Lemmings-family source but may not yet initialise as an editable campaign until its own level count/order/graphics conventions are added.

This separation is deliberate: archive/disk extraction is now generic enough to reuse, while each game's campaign definition can be added as a separate format profile rather than forcing every variant into the original 120-level structure.

## Special levels

The editor can assign any of the four existing Amiga special backdrops (`special0`…`special3`) to another physical level by changing the level's special selector.

The project format includes a reserved `customSpecials` collection for future work, but v0.13 does not claim that a fifth unique `specialX` file can yet be loaded by the unmodified game. That depends on proving whether the Amiga loader has a hard-coded four-entry filename/table limit and patching it if necessary.


## v0.13 import diagnostics

v0.13 keeps the same source formats as v0.11 but makes the import path observable. The page now shows the selected filename immediately, reports each major archive/disk extraction stage, and displays startup/import exceptions in an on-page diagnostics log. `app/editor-standalone.html` is also supplied with all CSS and JavaScript embedded in one file for browsers that restrict companion scripts when an HTML file is opened directly from disk.

### Which HTML file to open

Start with `app/index.html`. If selecting a source file does not cause the diagnostics panel to update, open `app/editor-standalone.html` instead. The standalone build contains the same v0.13 editor with all CSS and JavaScript embedded into one HTML file, removing local companion-script loading from the equation.


## v0.13 startup fix

`app/index.html` is now completely self-contained: CSS, archive/disk import code, game-data metadata and the editor application are embedded in the one file. This removes the dependency on browsers loading companion JavaScript files from a local `file://` page.

Startup is staged in the Import diagnostics panel. It should report `Data metadata loaded`, `LHA/disk importer loaded`, and `Editor application loaded`. If a stage fails, its actual exception/line is displayed instead of only `Script error.`

`app/editor-standalone.html` is an identical alias of the same self-contained build.
