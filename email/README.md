# @spy4x/email

Email primitives: an SMTP transport behind a small `EmailSender` port, and a pure
RFC 6376 DKIM verifier.

## Install

```bash
deno add jsr:@spy4x/email
```

Runs on: server (Deno).

## Modules

Each module's usage is in its module doc, shown by `deno doc` and on JSR.

- [`@spy4x/email`](mod.ts): Barrel entry point for `@spy4x/email`.
- [`@spy4x/email/address`](address.ts): Mailbox parsing for the `From` header and the recipient list.
- [`@spy4x/email/html`](html.ts): HTML escaping and the shared HTML email shell.
- [`@spy4x/email/letter`](letter.ts): A brand-free letter shell for mail an app sends to people who asked for it.
- [`@spy4x/email/message`](message.ts): The message shape a transport sends, plus the pieces of rendering that are library concerns rather than app concerns.
- [`@spy4x/email/sender`](sender.ts): The `EmailSender` port and the dev adapter that satisfies it.
- [`@spy4x/email/smtp`](smtp.ts): The SMTP adapter.
- [`@spy4x/email/dkim-verify`](dkim-verify.ts): DKIM signature verification per RFC 6376.
