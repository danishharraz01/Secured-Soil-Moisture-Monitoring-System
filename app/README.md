# Soil Monitor - Android app

Flutter app of the Secured Soil Moisture Monitoring System: login with password
and an emailed one-time code, live dashboard, activity history, daily report,
settings, local notifications.

## Run it

1. Start the backend from the repository root: `npm run demo` (or `npm run db`,
   `npm run syslog`, `npm run server`, `npm run device` in separate terminals).
   `npm run setup` copied the pinned certificate to `app/assets/server.crt`.
2. Start an Android emulator (Android Studio -> Device Manager) or plug in a phone.
3. Run the app:

   ```bash
   cd app
   flutter pub get
   flutter run
   ```

### Server URL

| Where the app runs           | Do this                                         | Server URL in the app        |
| ---------------------------- | ----------------------------------------------- | ---------------------------- |
| Android emulator             | `adb reverse tcp:8443 tcp:8443`                 | `https://localhost:8443`     |
| Android emulator (no adb)    | -                                               | `https://10.0.2.2:8443`      |
| Phone on the same Wi-Fi      | allow port 8443 in the PC firewall              | `https://<PC LAN IP>:8443`   |

The certificate covers `localhost`, `127.0.0.1`, `10.0.2.2` and the PC's LAN
addresses at setup time (see `CREDENTIALS.txt`). If your IP changed, run
`npm run reset`, then rebuild the app so it bundles the new certificate.

### Logging in

Usernames and passwords are in `CREDENTIALS.txt`. The 6-digit code is emailed;
without SMTP settings it is written to `outbox/email-<time>.txt` in the
repository root. One wrong code cancels it - log in again for a new one.

## Security in the app

- **Certificate pinning** - `SecurityContext(withTrustedRoots: false)` with only
  `assets/server.crt`; `badCertificateCallback` always returns false. The
  phone's CA store is not used, so a proxy or MITM certificate is refused.
- **HTTPS only** - the URL must start with `https://`; the manifest sets
  `usesCleartextTraffic="false"`.
- **Token storage** - the session token lives only in `flutter_secure_storage`
  (Android Keystore-backed AES-GCM). The password is never stored and the
  field is cleared after step 1. `allowBackup="false"` keeps the token out of
  device backups.
- **10-minute session** - countdown on the dashboard; at 00:00 or on any 401
  the token is deleted and the login screen explains why.
- **10 s timeout** on every request.

## Tests

```bash
flutter analyze
flutter test                                    # unit + widget tests
flutter test test_screenshots --update-goldens  # regenerates docs/screenshots/app-*.png
```

The screenshots render the real app widgets against a fake API with sample
data (they are documentation, not part of the normal test run).
