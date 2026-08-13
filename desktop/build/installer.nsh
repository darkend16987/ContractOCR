; ---------------------------------------------------------------------------
; Nabu PDF — installer customisation.
;
; Registers ONE Explorer shortcut-menu verb: select several PDFs, right-click,
; "Gộp bằng Nabu PDF" → the app opens its merge dialog pre-filled with them.
; The matching runtime half is src/shell-combine.js + main.js's combineBucket.
;
; THINGS THAT LOOK OPTIONAL AND ARE NOT
;
;   MultiSelectModel = Player
;     Without it a command-line verb defaults to the "Document" model, and
;     Explorer HIDES the menu item as soon as more than 15 files are selected —
;     i.e. it would silently stop working on exactly the batches worth merging.
;     "Player" raises that ceiling to 100 (a legacy verb cannot go higher; only
;     a COM IDropTarget handler is uncapped, which an Electron app cannot supply
;     without a native helper).
;
;   SystemFileAssociations\.pdf, not our own ProgID
;     The verb has to appear for every .pdf regardless of which application owns
;     the extension. Hanging it off Nabu's ProgID would make it appear only for
;     users who already made Nabu their default PDF viewer.
;
;   SHCTX, not a hard-coded HKCU/HKLM
;     NSIS resolves SHCTX from the install mode electron-builder already set
;     (SetShellVarContext current|all), so a per-user install writes HKCU and an
;     elevated per-machine install writes HKLM. Hard-coding HKCU would register
;     the verb for the ADMIN account when a per-machine install is elevated by
;     someone else — i.e. for the wrong user, silently.
;
;   %1 and one process per file
;     A command-line verb is invoked once per selected file, so "%1" is correct
;     and deliberate; the app reassembles the batch (see src/shell-combine.js).
;
; WINDOWS 11: this is a legacy registry verb, so it appears under
; "Hiện thêm tùy chọn" (Show more options / Shift+F10), NOT in the short modern
; menu. That menu only accepts an IExplorerCommand registered through a SIGNED
; sparse MSIX package, and Nabu ships unsigned (see SIGNING.md). Documented in
; the user guide so the item is not reported missing.
;
; This file is UTF-8 with a BOM because the verb label is Vietnamese; NSIS 3
; needs the BOM to read it as UTF-8. If the menu item ever shows mojibake, that
; BOM is the first thing to check.
; ---------------------------------------------------------------------------

!define NABU_COMBINE_KEY "Software\Classes\SystemFileAssociations\.pdf\shell\NabuCombine"

!macro customInstall
  WriteRegStr SHCTX "${NABU_COMBINE_KEY}" "MUIVerb" "Gộp bằng Nabu PDF"
  WriteRegStr SHCTX "${NABU_COMBINE_KEY}" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "${NABU_COMBINE_KEY}" "MultiSelectModel" "Player"
  WriteRegStr SHCTX "${NABU_COMBINE_KEY}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --nabu-combine "%1"'
!macroend

!macro customUnInstall
  ; Leaving this behind would keep a dead menu item pointing at a deleted exe.
  ; DeleteRegKey removes the `command` subkey with it.
  DeleteRegKey SHCTX "${NABU_COMBINE_KEY}"
!macroend
