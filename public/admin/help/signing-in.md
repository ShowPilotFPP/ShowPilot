# Signing in

How to sign in to the ShowPilot admin, stay signed in, change your password, and get back in if you've forgotten it.

## The sign-in page

Enter your **Username** and **Password** and click **Log in** (or press Enter). Usernames aren't fussy about spaces at either end, but passwords must match exactly.

If the details are wrong you'll see **Invalid credentials**. The same message appears for an account that has been disabled on the [Users](help:users) page, so if you're sure of your password, ask another admin whether your account is switched off.

> **Careful:** After 8 failed attempts from the same place within 15 minutes, ShowPilot shows **Too many login attempts. Please wait a few minutes and try again.** Wait, then try again. Successful sign-ins don't count towards the limit.

## First sign-in on a new install

A brand-new ShowPilot has one account: username **admin**, password **admin**. As soon as you sign in, a **Change Password Required** box appears. It has no Cancel button: choose a new password before you carry on.

### Restoring a backup instead

On a brand-new install, the sign-in page also shows **New install? You can restore from a previous ShowPilot backup** with a file picker. Choose a ShowPilot backup file and confirm. ShowPilot restores the backup and restarts itself, and the page reloads after a few seconds. If it can't restart on its own, the page tells you to restart ShowPilot and reload. Then sign in with a username and password from the backup, not admin/admin.

This option disappears once the default admin password has been changed. After that, restore from [Settings › Backup & Restore](help:settings-backup).

## Remember me on this device (30 days)

Tick **Remember me on this device (30 days)** to stay signed in on this browser for 30 days, even after you close it. Leave it unticked on a shared or public computer: you're then signed out when the browser closes.

Your choice is saved with your account, and the [Users](help:users) list shows **30-day session** for accounts that use it.

## Signing out

Click **Log out** next to your name at the top right of the admin. Signing out on one browser doesn't affect others.

## Changing your password

1. Open **Users**.
2. Click **Change My Password**.
3. Enter your **Current password**, then your **New password** twice (**Confirm new password**).
4. Click **Change Password**.

New passwords must be at least 4 characters. Longer is much better, especially if your admin can be reached from the internet.

When another admin resets your password, you'll be asked to change it the next time you sign in, the same way as on first sign-in.

## Forgot your password?

### Another admin can reset it

Everyone in the **Users** list has full admin rights. Ask someone who can still sign in to open **Users**, click **Reset PW** next to your account and set a temporary password. You sign in with it and are asked to choose your own straight away. See [Users](help:users).

### Nobody can sign in

ShowPilot has no "email me a reset link". If there's no other admin, you need access to the computer ShowPilot runs on. If your server's host manages ShowPilot for you, ask them instead.

The fix is to delete the account from ShowPilot's database and restart. When **no accounts at all** are left, ShowPilot creates the default **admin** / **admin** account again on start-up, and asks for a new password when you sign in. Your sequences, settings and templates are not affected.

From the ShowPilot folder on that computer, with the sqlite3 tool installed:

```
sqlite3 data/showpilot.db "DELETE FROM users WHERE username='admin';"
```

Then restart ShowPilot.

> **Important:** The default account only comes back when the users list is completely empty. If you had other accounts too, delete those as well (or reset one of them as above), otherwise you'll still have no way in.

> **Tip:** Make a backup from [Settings › Backup & Restore](help:settings-backup) before touching the database.
