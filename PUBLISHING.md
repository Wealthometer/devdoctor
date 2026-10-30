# Publishing DevDoctor to npm

You publish 0.1.0 once from your laptop, then link the package to GitHub. After that, every release is three commands: `npm version`, `git push --follow-tags`, and a check.

## How it works

npm no longer wants long-lived tokens in CI. Tokens that skip 2FA lose direct publishing around January 2027. Instead, GitHub Actions proves who it is to npm with a short-lived OIDC token. This is called **trusted publishing**, and `.github/workflows/release.yml` is already set up for it.

1. **Once, by hand:** publish 0.1.0 from your laptop, so the package exists on npm.
2. **Once, on npmjs.com:** tell the package to trust `release.yml` in your GitHub repo.
3. **Every release:** bump the version and push the tag. GitHub runs the tests, publishes with provenance, and creates the GitHub release with notes.

## 1. One-time setup and the first publish

Run these from the repo folder on your laptop.

1. **Create an npm account** at [npmjs.com/signup](https://www.npmjs.com/signup), then turn on two-factor authentication under Account → Two-Factor Authentication.
2. **Check the name is still free:** run `npm view devdoctor`. A `404 Not Found` means it's yours to take.
3. **Add your GitHub repo to `package.json`.** Trusted publishing only works if this URL matches your repo exactly, including capital letters. Replace `YOUR-USERNAME` and paste these lines under `"license"`:

   ```json
   "repository": { "type": "git", "url": "git+https://github.com/YOUR-USERNAME/devdoctor.git" },
   "homepage": "https://github.com/YOUR-USERNAME/devdoctor#readme",
   "bugs": "https://github.com/YOUR-USERNAME/devdoctor/issues",
   ```

   In `site/index.html`, replace `YOUR-USERNAME` in the same way.
4. **Commit and push:**

   ```bash
   git commit -am "chore: add repository links" && git push
   ```

5. **Log in to npm:** run `npm login`, which opens your browser. Then run `npm whoami`; it should print your username.
6. **Check what will be published:**

   ```bash
   npm ci && npm run build && npm pack --dry-run
   ```

   The file list should show only `bin/`, `dist/`, `schemas/`, `README.md`, `LICENSE` and `package.json`. If you see tests, `.env` or anything private, stop here.
7. **Publish:**

   ```bash
   npm publish --access public
   ```

   This runs the type check, the tests and the build first, then asks for your 2FA code.
8. **Tag the release:**

   ```bash
   git tag v0.1.0 && git push --tags
   ```

   The release workflow sees that 0.1.0 is already on npm, so it skips publishing and only creates the GitHub release.

The package is now at `https://www.npmjs.com/package/devdoctor`, and anyone can run `npx devdoctor check`.

## 2. Turn on trusted publishing

This lets GitHub Actions publish for you without storing an npm token anywhere. Finish it within 2 days of saving: a configuration that hasn't been used for a publish by then expires.

1. On npmjs.com, open **devdoctor → Settings → Trusted Publisher** and choose **GitHub Actions**.
2. Fill in the fields exactly. They are case-sensitive, and npm only checks them when a publish runs.

   | Field | Value |
   | --- | --- |
   | Organization or user | your GitHub username |
   | Repository | `devdoctor` |
   | Workflow filename | `release.yml` (the file name only, not the path) |
   | Environment | leave empty |

3. Save. You don't need an `NPM_TOKEN` secret in GitHub; if you made one earlier, delete it.

The workflow already has what npm requires: `id-token: write` permission, and Node 24, which ships npm 11.5.1 or newer. Because the repo is public, provenance (the "Built and signed on GitHub Actions" badge) is added automatically.

## 3. Every release after that

Choose the version bump from what changed since the last release. `npx commitsmith changelog` prints a "suggested version" to help you decide.

| What changed | Command | 0.1.0 becomes |
| --- | --- | --- |
| Bug fixes only | `npm version patch` | 0.1.1 |
| New features, nothing broken | `npm version minor` | 0.2.0 |
| Something breaks for users | `npm version major` | 1.0.0 |
| A test release | `npm version prerelease --preid beta` | 0.1.1-beta.0 |

Then:

1. Run the `npm version …` command from the table. It updates `package.json`, commits, and creates the tag (for example `v0.1.1`). Your working tree must be clean before you run it.
2. Run `git push --follow-tags`. This pushes the commit and the tag together, and the tag starts the Release workflow.
3. Watch the run in your repo's **Actions** tab. It takes about 2 minutes: tests, build, publish, then the GitHub release.
4. Check the release landed: `npm view devdoctor version` should print the new number, and `npx devdoctor@latest --version` should work from any folder.

If the tests fail in the workflow, nothing is published. Fix the problem, then move the tag (see Troubleshooting).

## Fixing mistakes

Once a version number has been published, it can't be used again, even after an unpublish. Fix forward with a new version instead.

- **Broken release:** publish a fix with `npm version patch`, then warn people off the bad version:

  ```bash
  npm deprecate devdoctor@0.1.1 "Broken CLI on Windows, use 0.1.2"
  ```

  Installs of that version still work, but they show your message.
- **Published by accident, within 72 hours:** run `npm unpublish devdoctor@0.1.1`. After 72 hours, or once other packages depend on it, deprecate it instead.
- **Beta releases:** run `npm version prerelease --preid beta`, then `git push --follow-tags`. The workflow publishes any version with a dash in it under the `next` tag. People opt in with `npm install devdoctor@next`; everyone else keeps getting the stable version.
- **Point `latest` back at an older version:** run `npm dist-tag add devdoctor@0.1.0 latest`.

## Troubleshooting

| You see | What it means | Fix |
| --- | --- | --- |
| `ENEEDAUTH` or `E401` on your laptop | You're not logged in | Run `npm login`, then `npm whoami` |
| `EOTP` | npm wants your 2FA code | Run the command again and enter the code, or add `--otp=123456` |
| `E403 You cannot publish over the previously published versions` | That version number is already used | Run `npm version patch` and publish again |
| `E403 … do not have permission` | Someone else owns the name | Choose another name in `package.json`, for example `@your-username/devdoctor`. Scoped packages need `--access public`. |
| `E404` or `ENEEDAUTH` in the Release workflow | The trusted publisher fields don't match | Recheck the username, repo and `release.yml` on npmjs.com, and check that `repository.url` in `package.json` is your exact repo |
| The "Check the tag matches package.json" step fails | You pushed a tag by hand that doesn't match the version | Always create tags with `npm version …`. To redo a tag: `git tag -d v0.1.1 && git push origin :refs/tags/v0.1.1`, fix the problem, then tag and push again |
| Tests fail in the workflow | Nothing was published | Fix the tests, commit, then move the tag as in the row above |
| `npm view` still shows the old version | The registry takes a minute to update | Wait, then run `npm view devdoctor version` again |

## The landing page

`site/index.html` is the whole website: one file with no build step. The **Pages** workflow publishes it to GitHub Pages whenever `site/` changes on `main`. To turn it on: open the repo's **Settings → Pages**, set **Source** to **GitHub Actions**, then push. The site appears at `https://YOUR-USERNAME.github.io/devdoctor/`.

To preview the page locally, open `site/index.html` in your browser.

## Sources

- [npm Docs: Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers)
- [GitHub Changelog: Restricting npm bypass-2FA granular access tokens (31 Jul 2026)](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens)
