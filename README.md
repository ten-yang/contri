# Contri

Split shared costs with friends. Everyone has their own profile, can be in several groups, and sees the same balances from their phone.

- Profiles with a username, password and a one-time recovery code (no email or phone number)
- Groups you join with a private link plus a passcode
- Split equally, by exact amounts, or by percentage; one currency per group
- Live balances and the fewest payments to settle up, across all your groups on the home screen
- Every change is recorded in Activity, deleted items can be restored for 30 days, and a copy of each group is saved every night (last 30 kept)
- Receipt photos delete themselves 30 days after they're added
- Only the person who created a group can change its passcode, money setting, or delete it. Anyone can leave once they're settled up; a creator hands the group to someone else first

## What's inside

```
public/            the app (index.html, app.js, images, home-screen icons)
api/auth.js        sign up, log in, reset with recovery code, profile changes
api/group.js       create, join, expenses, settings, leaving
api/home.js        your groups and balances for the home screen
api/receipt.js     receipt photos
api/backup.js      download a nightly copy
api/cron.js        nightly copies and clean-up (scheduled in vercel.json)
api/_lib.js        storage, validation, sessions, shared maths
test/              local test server with an in-memory database, and checks
```

Data lives in an Upstash Redis database connected through Vercel. Test links (Vercel previews) use a separate set of keys, so trying things out never touches real groups.

## Moving over from the first version

The first version had one group and a shared passcode. Its invite link is now `/g/v4Cm9Lr2Qa`. The first person to open it, enter the old passcode and pick their name becomes that group's creator. Everyone else does the same, picking their own name, so their past expenses stay theirs.

## Running the checks

```
node test/api.test.js
node test/ui.test.mjs     # needs Playwright
```
