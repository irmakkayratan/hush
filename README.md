# HUSH

HUSH turns written and spoken notes into English updates for existing Notion tasks. Team members review the suggested task, update and status before confirming a send.

## Try the demo

Download the repository and open `docs/index.html` in a browser. The demo uses sample notes and runs without accounts, keys or paid services. To embed it in a portfolio, publish the `docs` folder with [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) and use the resulting HTTPS URL in an iframe with the title `HUSH demo`.

## Run the full application locally

You need Node.js 22 or newer, a Supabase project, a Notion public integration and an OpenAI API key. OpenAI bills usage separately.

1. In a new Supabase project, run these files in the SQL Editor in order. The scripts start with an empty HUSH schema.

   1. [base.sql](supabase/base.sql)
   2. [create-team.sql](supabase/create-team.sql)
   3. [save-notion-connection.sql](supabase/save-notion-connection.sql)
   4. [notion-management.sql](supabase/notion-management.sql)
   5. [notion-refresh.sql](supabase/notion-refresh.sql)
   6. [team-invites.sql](supabase/team-invites.sql)
   7. [notion-delivery.sql](supabase/notion-delivery.sql)
   8. [reminders.sql](supabase/reminders.sql), if you want notifications

   For a single file that includes all eight scripts, run `node scripts/install-hush-database.mjs > hush-database.sql` and paste the generated SQL into the editor.

2. Create and confirm your first email/password user in **Authentication → Users** in Supabase.
3. Copy `.env.example` to `.env.local`. Add the Supabase project URL, publishable key and server secret under the corresponding names. The server secret, OpenAI key and Notion client secret belong in your local file or hosting environment.
4. Create a [Notion public integration](https://developers.notion.com/docs/authorization) with read, insert and update content capabilities. Register `http://localhost:3000/api/notion/oauth/callback` as the redirect URL. Add its client ID and client secret to `.env.local`. Set `HUSH_TOKEN_ENCRYPTION_KEY` to the output of `openssl rand -hex 32` and keep that key across restarts to preserve your Notion connections.
5. In the repository directory, run the following commands.

   ```sh
   npm ci
   npm run dev
   ```

6. Open [Create a team](http://localhost:3000/create-team), sign in and create a team. Select **Connect Notion**, grant access to your test task list and map its title, status and optional date fields. Return to [HUSH](http://localhost:3000), open the team and save a note.

## Run a production build

Use a Node.js web service and set the same environment values there. When using the same Supabase project, use the same Notion integration credentials and token encryption key as your development setup. The repository supports local team and Notion setup through the development server. The production app uses those existing teams and connections.

```sh
npm ci
npm run build
npm start
```

Set up HTTPS for access from an iPhone. The server must accept multipart requests up to 12 MiB for 10 MiB audio recordings.

## Install on iPhone and test Apple Watch notifications

1. Run [reminders.sql](supabase/reminders.sql) if you skipped it above. Create a Web Push key pair once with `npx web-push generate-vapid-keys`. Set `NEXT_PUBLIC_HUSH_PUSH_PUBLIC_KEY`, `HUSH_PUSH_PRIVATE_KEY` and `HUSH_PUSH_SUBJECT` in `.env.local` or the hosting environment. Use a contact such as `mailto:owner@example.com` for the subject. Rebuild after changing the public key.
2. In a separate terminal or process on the host, run `npm run reminders`. Leave it running to send scheduled reminders when HUSH is closed.
3. On iOS 16.4 or later, open the HUSH HTTPS URL in Safari. Use **Share → Add to Home Screen**, then open HUSH from its new icon.
4. Sign in, open a team, choose **Test notifications** and press **Schedule a test in one minute**. Allow notifications. For the Watch test, keep the paired Apple Watch unlocked on your wrist and lock the iPhone.
5. To schedule a task reminder, analyze a note and open **Set a task reminder** under its suggested task date. Choose a time in your device’s time zone and press **Schedule reminder**.

Reminders go to the device on which you schedule them. Task reminders open the associated Notion task. Apple controls whether the alert appears on the iPhone or its paired Watch. The worker claims each reminder before sending and attempts it once. An expired subscription or an interrupted send can require scheduling the reminder again.

[Apple Home Screen web push](https://webkit.org/blog/13878/) · [Apple Watch notification routing](https://support.apple.com/en-us/108274)
