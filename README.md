# Lemmings Amiga HTML5 Editor v0.10

First editable build based on the validated Amiga-data viewer.

## Run

Open `app/index.html` directly in a modern browser. No Node, build step or web server is required.

Choose the extracted folder containing the original supplied Amiga data (`Level000`…`Level024`, `Ground1`…`Ground5`, `Objects1`…`Objects5`, `oddtable`, `special0`…`special3`).

## Implemented in v0.10

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

The v0.10 level writer was round-tripped against all 100 supplied physical level records. With no edits, parse -> write reproduces all 100 original 2048-byte records byte-for-byte. The `oddtable` writer likewise reproduces the supplied 4480-byte file byte-for-byte.

The editor preserves source slot positions for terrain, objects and steel. It also preserves two observed terrain-record bits that lie outside the currently decoded terrain ID/X/Y/draw-flag fields, so untouched records are not normalised destructively during export.

## Current export boundary

`Level###` source files are ByteKiller-compressed. v0.10 deliberately exports the edited level records/packs uncompressed as writer-validation outputs; they are not yet direct drop-in replacements for the original compressed files.

Campaign order and difficulty-group order are also currently project/export data. The Amiga-native runtime tables which must be patched to make a changed order boot directly in the original executable remain to be located/proved.

## Special levels

The editor can already assign any of the four existing Amiga special backdrops (`special0`…`special3`) to another physical level by changing the level's special selector.

The project format includes a reserved `customSpecials` collection for future work, but v0.10 does not claim that a fifth unique `specialX` file can yet be loaded by the unmodified game. That depends on proving whether the Amiga loader has a hard-coded four-entry filename/table limit and patching it if necessary.
