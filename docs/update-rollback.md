# Updating & Rolling Back

Nexotao Agents is distributed on npm as `nexotao` and installed globally. Your data lives outside the
package (under `~/.nexotao` or `NEXOTAO_DATA_DIR`), so updating or rolling back the package never
touches it.

## Checking for updates

The app periodically checks the npm registry for a newer published version and indicates when one is
available. This check reports only whether an update exists; it sends no account or usage data.

## Updating

```bash
npm install -g nexotao@latest
```

Then restart the app (`nexotao`). On startup the database schema is **migrated forward**
automatically: any new migrations are applied inside transactions and recorded in
`schema_migrations`. Migrations are additive, so existing records are preserved.

If you are upgrading from a version that stored data as JSON files, the first launch detects those
files, copies them to `~/.nexotao/backups/json-v1-<timestamp>/`, and imports them in a single
transaction. The import is recorded so subsequent launches do not duplicate records.

## Rolling back to a prior version

Install a specific earlier version:

```bash
npm install -g nexotao@<previous-version>
```

Then restart the app.

**Important:** database migrations are forward-only. A newer version may have applied schema changes
that an older version does not expect. Before updating — especially before a beta update you may want
to reverse — take a backup so you can roll the data back as well:

1. Stop the app.
2. Copy your data directory (`~/.nexotao` or `NEXOTAO_DATA_DIR`) to a safe location.

### Restoring data from a backup

If you need to return to the state captured in a backup:

1. Stop the app.
2. Move the current `~/.nexotao/nexotao.sqlite` aside (do not delete it until the rollback is
   verified).
3. Copy your backed-up data directory (or `nexotao.sqlite`) back into place.
4. Start the previous `nexotao` version.

### Rolling back the legacy-JSON migration

If you upgraded from JSON storage and need to return to a JSON-only version:

1. Stop the app.
2. Move `~/.nexotao/nexotao.sqlite` to a safe location.
3. Copy the JSON files from `~/.nexotao/backups/json-v1-<timestamp>/` back into `~/.nexotao/`.
4. Start the previous version.

The backup reflects state immediately before migration; changes made after the SQLite upgrade remain
in the moved database and are not visible to a JSON-only version.

## Notes

- Uninstalling (`npm uninstall -g nexotao`) leaves your data directory intact. To erase all local
  state, delete the data directory manually. See [privacy.md](privacy.md#deleting-your-data).
- For the beta rollout and its rollback triggers, see [staged-rollout.md](staged-rollout.md).
