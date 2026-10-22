# Contri

A shared expense ledger for a small group. Anyone with the link and the group passcode can add expenses, split them, and see the same balances from their phone. No accounts needed.

- Split equally, by exact amounts, or by percentage
- Live balances and the fewest payments to settle up
- Every entry shows who logged it and who last edited it
- An activity feed records every add, edit and delete, so nothing disappears quietly

## What's inside

```
public/          the app (index.html, app.js, images, home-screen icons)
api/data.js      the one server endpoint, runs as a Vercel function
api/_lib.js      passcode check, validation, storage connection
```

Data lives in an Upstash Redis database that you connect through Vercel. The free tier is plenty for a household or a trip.

## Deploy to Vercel (about 15 minutes)

You need Node.js installed and a free Vercel account.

**1. Upload the project**

Unzip this folder, open a terminal in it, and run:

```
npx vercel
```

Log in when asked and accept the defaults. This creates the project and a first test deploy. The app won't work yet; that's expected.

**2. Connect storage**

In the Vercel dashboard, open the project, go to the **Storage** tab, and create an **Upstash for Redis** database (it's listed in the Marketplace). Connect it to this project for all environments. Vercel adds the connection settings for you.

**3. Set the group passcode**

In the project, go to **Settings → Environment Variables** and add:

| Name | Value |
|---|---|
| `GROUP_PASSCODE` | a passphrase you'll share with the group, e.g. `blue-otter-dosa-42` |

Pick something longer than a 4-digit PIN. After 10 wrong tries, a device is locked out for 15 minutes.

**4. Go live**

```
npx vercel --prod
```

Vercel prints your site's address, something like `contri-yourname.vercel.app`.

**Prefer GitHub?** Push this folder to a new GitHub repo, then in Vercel choose **Add New → Project** and import it. Do steps 2 and 3, then redeploy from the dashboard.

## First use

1. Open the link on your phone and enter the passcode.
2. Add your name. You'll be asked once per device.
3. Add the others, or just send them the link and passcode so they can join themselves.
4. On iPhone, tap Share → **Add to Home Screen** for an app icon. On Android, use the browser menu → **Add to Home screen**.

## Good to know

- **The passcode is the lock.** Anyone with the link and passcode can see and change entries. To cut someone off, change `GROUP_PASSCODE` in Vercel and redeploy. Everyone will be asked for the new one.
- **Names are on trust.** The app doesn't verify that "Tenzin" is really Tenzin. The activity feed still shows every change, so mistakes are easy to spot.
- **Updates appear within about 8 seconds** while the app is open, and right away when you switch back to it.
- **Changing the app later:** edit the files and run `npx vercel --prod` again. Your data stays in the database.
- **Images** are from Storyset. Their free license asks for a credit line such as "People illustrations by Storyset" linking to storyset.com, unless you have a premium plan.
