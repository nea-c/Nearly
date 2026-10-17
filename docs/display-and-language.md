# Display density and language

Language / 言語 is the first settings control, before Theme. Its choices always remain 日本語 and English. New optional unified appearance fields are language (ja/en, default ja) and compactExplorer (boolean, default false). Missing fields do not by themselves trigger a startup save; malformed explicit values fail validation. Every deliberate save retains the existing revision/CAS and atomic primary/backup behavior. Storage remains adjacent to the running EXE; no general migration or fallback is introduced.

Compact mode changes explorer row geometry rather than font size: list rows24px, folder tree22px, connection tree23px and bookmark tree menu24px. Existing row nodes, selection, tree expansion and horizontal scrolling are retained, and a visible row anchor is restored when density changes. Icons, palettes and explicit Light/Dark/Midnight behavior remain intact.

Translations are centralized in source-string catalog shards. Explicit t/text/html call sites distinguish application-owned text from data. The html tag translates only literal source segments and escapes translated phrases; interpolated values retain their existing escaping and are never translated. Paths, names, bookmark labels, host fingerprints and technical identifiers stay opaque. Owned error adapters recognize complete literals/templates and preserve captured user/OS details.

OS-native buttons and messages, external SSH/SFTP/OS details and technical diagnostic/activity logs can remain verbatim. The final verification report inventories native/catalog coverage and explicit exclusions; a zero missing-key counter alone is not evidence of complete localization. Native picker title/filter text is localized by an explicit validated language argument, without reading or storing keys during tests.

Verification uses generated settings, local mock/IPC fixtures and a distinct Tauri QA application identifier. The production identifier is never launched for QA. The final release process compares the live primary and backup existence, content hashes, sizes and modification times before/after publication. No real saved server operation or user-preference change is part of QA.
