# Account copy

Wording for account emails and pages. The live text is in `services/email/templates.js` (emails) and `views/app/auth/` (pages); change both places together.

- Write the app name from `config/brand.js` (`appName`), shown here as {appName}.
- Tone: full, professional sentences. Minimalist, but never shorthand like a bare "Check your inbox."
- Nothing a visitor sees on the site may differ between an email that has an account and one that doesn't.
- Emails never include anything a visitor typed, not even a name: anyone can enter any address, and a name would let a stranger put their own words in an email sent from genlpt.com.
- Every email ends with "The {appName} team". A main button also gets a plain link below it: "If the button doesn't work, copy and paste this link into your browser:"

Status legend: **agreed** (reviewed with you) or **draft** (written, waiting for your review).

## Emails

### Signup with an email that already has an account

**Status:** body agreed 2026-10-03; subject draft

Sent only to the owner of the address. The signup page itself shows the same confirmation as for a new address.

**Subject:** A {appName} account already exists for this email address

> We received a request to create a {appName} account using this email address, which is already registered with us.
>
> If this was you, you can log in to your existing account, or reset your password if you've forgotten it.
>
> [Log in] · [Reset my password]
>
> If this wasn't you, someone may have entered your email address by mistake or on purpose. No new account was created, and your existing account has not been changed. To keep your account secure, make sure your password is strong and isn't used on any other site.

Notes:
- Never tell the reader to ignore the message: someone really did use their address.
- Once a support address exists, add: "If you keep receiving these messages, contact us at …"

### Confirm your email address (signup)

**Status:** draft

**Subject:** Confirm your email address for {appName}

> Thank you for creating a {appName} account. Please confirm your email address to activate it.
>
> [Confirm my email address]
>
> This link expires in 24 hours and can be used only once.
>
> If you didn't create this account, someone may have entered your email address by mistake or on purpose. The account will not be activated unless this link is used, and it will be deleted automatically after 7 days.

### Reset your password

**Status:** draft

**Subject:** Reset your {appName} password

> We received a request to reset the password for your {appName} account. To choose a new password, use the button below.
>
> [Reset my password]
>
> This link expires in 1 hour and can be used only once.
>
> If you didn't request a password reset, someone may have entered your email address by mistake or on purpose. Your password has not been changed, and it will stay the same unless this link is used.

## Pages

### After any signup: Check your inbox

**Status:** draft

> Thanks for signing up. We've sent an email to {email} with the next steps.
>
> If it doesn't arrive within a few minutes, please check your spam folder or request a new email.
>
> [Send a new email] · Back to log in

After "Send a new email", the first paragraph becomes: "We've sent another email to {email} with the next steps. Please allow a few minutes for it to arrive."

Notes:
- It must stay true for both cases: a new address gets an activation link, a registered one gets the notice above. That's why it says "the next steps" and not "a confirmation link".
- Under the signup form's button: "We'll send you an email to confirm your address."

### Login with the right password, email not confirmed yet

**Status:** draft

> Please confirm your email address before logging in. We sent a confirmation link to {email} when you signed up.
>
> [Send a new link]

### Behind the confirmation link: Confirm your email address

**Status:** draft

> Confirm that {email} is your email address to activate your {appName} account.
>
> [Confirm and continue]

The link opens this page and only the button confirms: mail scanners open links to check them, and would otherwise use up the link before the person can.

### Expired or used link: This link is no longer valid

**Status:** draft

> The link has expired or has already been used. For your security, each link works only once and for a limited time.

Then, for a confirmation link: "To receive a new confirmation link, log in with your email address and password." [Log in]
For a reset link: "You can request a new link to reset your password." [Request a new link]

### Forgot password: Reset your password

**Status:** draft

> Enter the email address you use for {appName}. We'll send you a link to choose a new password.
>
> [Send reset link] · Back to log in

### After a reset request: Check your inbox

**Status:** draft

> If an account exists for {email}, we've sent a link to reset your password. The link expires in 1 hour.
>
> If you don't receive an email within a few minutes, please check your spam folder and make sure you entered the address you signed up with.

### Behind the reset link: Choose a new password

**Status:** draft

> Enter a new password for {email}. Once it's saved, you'll be logged out on your other devices.
>
> [Save new password]

### Messages on the forms

**Status:** draft

- Wrong email or password.
- Too many attempts. For your security, please wait {n} minutes before trying again.
- Accounts are unavailable right now. Please try again in a moment, or continue as a guest.
- Please enter your name (80 characters max). / Please enter a valid email address.
- Your password needs at least 8 characters. / Your password can have at most 200 characters.
