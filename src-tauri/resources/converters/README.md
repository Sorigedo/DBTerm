# DBTerm bundled document converters

Place document conversion engines here before building the desktop bundle.
DBTerm can also download supported platform packages at runtime into the app
data `converters` directory.

Expected layout:

- `libreoffice/macos/LibreOffice.app/Contents/MacOS/soffice`
- `libreoffice/windows/program/soffice.exe`
- `libreoffice/linux/program/soffice`
- `poppler/macos/pdftotext`
- `poppler/windows/pdftotext.exe`
- `poppler/linux/pdftotext`

At runtime DBTerm searches the bundled resource directory first, then falls back
to system `PATH` only for development convenience.

Runtime installer defaults:

- Windows x64: LibreOffice MSI is downloaded and extracted into
  `libreoffice/windows`; Poppler zip is extracted into `poppler/windows`.
- macOS arm64/x64: LibreOffice DMG is mounted and `LibreOffice.app` is copied
  into `libreoffice/macos`.

`DBTERM_LIBREOFFICE_URL` and `DBTERM_POPPLER_URL` can override the default
download URLs for internal mirrors.
