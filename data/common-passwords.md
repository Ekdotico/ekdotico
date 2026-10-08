# The list of known passwords

`common-passwords.txt` is the list FR-AU-82 asks for: commonly used and known-compromised passwords, shipped with the application and read on the server. The owner's decision of 8 October 2026: a published list of at least 100,000 known-compromised passwords of 8 characters or more, recorded with its name, version, source and licence.

| What    | Value                                                                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name    | SecLists, `Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt`: the million most used passwords of Mark Burnett's ten million, most used first          |
| Version | Commit `2f19f39928b78e4be8b9a0f0a263baf531e33025` of `github.com/danielmiessler/SecLists`, of 8 October 2026                                                                |
| Source  | `https://raw.githubusercontent.com/danielmiessler/SecLists/2f19f39928b78e4be8b9a0f0a263baf531e33025/Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt` |
| Licence | MIT, the licence of SecLists (below). The passwords themselves were released to the public domain by their compiler (below)                                                 |
| Filter  | Each line in Unicode NFKC and lower case; kept where it has 8 to 32 code points and no control character; each entry once, in the order of the source                       |
| Entries | 476,776 of the source's 1,000,000                                                                                                                                           |
| Made by | `node scripts/build-password-list.mjs <the downloaded file>`. `tests/unit/password-list.test.ts` reads the result                                                           |

The entries are real passwords from published breaches. Some are offensive. They are data, and nothing here is a statement of the application's.

The limits of 8 and 32 are those of a password as they are first set (`PASSWORD_MIN_LENGTH`, `PASSWORD_MAX_LENGTH`). If the greatest length is raised, make the list again with the new limit, since longer entries were left out.

## What loading it costs

Measured on 8 October 2026 with Node.js 26 on the development machine: the file is 4.8 MB; it is read once, at the first password that is checked and not when the process starts, in about 140 ms; it then holds about 27 MB of memory for as long as the process runs; a check against it takes under a microsecond.

## Licence and attribution

SecLists is distributed under the MIT licence:

> MIT License
>
> Copyright (c) 2018 Daniel Miessler
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The passwords were compiled by Mark Burnett (xato.net), who published them on 9 February 2015 as a set "of ten million usernames and passwords that I am releasing to the public domain". The page that carried the release is itself marked Creative Commons Attribution-ShareAlike 3.0 Unported and asks that any use of its content include attribution to Mark Burnett (xato.net); this paragraph is that attribution. SecLists names the release as the origin of its file: `https://web.archive.org/web/20150211131735/https://xato.net/passwords/ten-million-passwords/`.

This file and the list are not under the licence of the rest of the repository (`AGPL-3.0-only`): the list keeps the terms above.
