# Google Play In-App Purchases (One-Time Products) & Backend Guide

## 1. Architecture Overview & Anti-Tampering Engine

### Why a Backend is Strictly Required
1. **Never Trust the Client**: A reverse-engineered APK or modded runtime (e.g. Frida, Lucky Patcher, Xposed) can hook `PurchasesUpdatedListener.onPurchasesUpdated()` and pass fake `Purchase` objects with status `PURCHASED`. If the client grants coins based solely on local callbacks, an attacker has unlimited free coins.
2. **Double-Crediting Prevention (Idempotency)**: The client or an attacker could replay the exact same `purchaseToken` repeatedly. The backend checks `purchase_transactions` where `purchase_token` is a `PRIMARY KEY / UNIQUE` constraint. If the token is already present, it is rejected with `409 Conflict`.
3. **Cross-Device Balance Persistence**: Local Room/SQLite databases are wiped upon app uninstallation or clearing data. Storing `coin_balance` on the server bound to the user's authenticated account (Firebase UID / Google ID) ensures coins follow the user across phones and tablets.
4. **Refund & Chargeback Revocation**: When a user claims a refund through Google Play or files a bank chargeback, Google sends a Real-Time Developer Notification (RTDN). The backend receives this event and automatically adjusts the player's coin balance or flags the account.

---

## 2. Google Play Console Setup Step-by-Step

### A. Package ID and App Registration
- **Package Name**: `com.aistudio.ludomaharaja.vzkqmn` (configured in `app/build.gradle.kts`)
- Go to [Google Play Console](https://play.google.com/console).
- Click **Create app**:
  - App name: **Lords of Ludo: Royal Edition**
  - Default language: **English (United States)** or **English (India)**
  - App or Game: **Game**
  - Free or Paid: **Free**

### B. Create the 4 Consumable One-Time Products
In the Play Console sidebar, navigate to **Monetize > In-app products**:
Click **Create product** for each of the 4 items:

| Product ID | Product Name | Description | Default Price (India) | Default Price (US) |
| :--- | :--- | :--- | :--- | :--- |
| `coins_100` | Handful of Coins | 100 Royal Gold Coins for betting & matches | ₹10.00 | $0.99 |
| `coins_500` | Pouch of Gold | 500 Royal Gold Coins (+50 Bonus) | ₹40.00 | $2.49 |
| `coins_1000` | Emperor's Chest | 1000 Royal Gold Coins (+150 Bonus) | ₹70.00 | $4.99 |
| `coins_5000` | Maharaja's Treasury | 5000 Royal Gold Coins (+1250 Mega Bonus) | ₹299.00 | $19.99 |

*Important*: Click **Activate** on each product after creation. Products in "Inactive" status will return `ITEM_UNAVAILABLE`.

### C. Link Google Cloud Service Account for Server-Side Verification
1. Open the [Google Cloud Console](https://console.cloud.google.com).
2. Ensure you are on the same project linked to Google Play (or create a project).
3. Navigate to **APIs & Services > Library**, search for **Google Play Android Developer API**, and click **Enable**.
4. Navigate to **IAM & Admin > Service Accounts** > **Create Service Account**:
   - Name: `play-billing-verifier`
   - Role: **Service Account Token Creator**
5. Click the created Service Account > **Keys** tab > **Add Key** > **Create new key** > **JSON**.
6. Download the key file as `service-account.json`.
7. In **Google Play Console**, navigate to **API access**:
   - Locate the newly created Service Account under "Google Cloud service accounts".
   - Click **Grant access**.
   - Under **App permissions**, select your Ludo game.
   - Under **Financial data permissions**, enable:
     - *View financial data, orders, and cancellation survey responses*
     - *Manage orders and subscriptions*
   - Click **Save**.

### D. Setup Real-Time Developer Notifications (RTDN) via Cloud Pub/Sub
1. In Google Cloud Console, open **Cloud Pub/Sub > Topics** > **Create Topic**:
   - Topic ID: `play-billing-notifications`
2. In the Permissions tab for the topic, add principal:
   - `google-play-developer-notifications@system.gserviceaccount.com`
   - Role: **Pub/Sub Publisher**
3. Create a **Push Subscription** pointing to:
   - `https://your-backend-domain.com/api/play-rtdn-webhook`
4. In Google Play Console, go to **Monetize > Monetization setup**:
   - In the **Real-time developer notifications** field, enter your Pub/Sub topic:
     `projects/{YOUR_PROJECT_ID}/topics/play-billing-notifications`
   - Click **Send test notification** to verify connection.

---

## 3. License Testing & Internal Testing Track Setup

### A. Add License Testers
1. In Google Play Console, navigate to **Setup > License testing**.
2. Add your tester email addresses (e.g. `PraveenPahuja54@gmail.com`).
3. Set **License test response** to:
   - `RESPOND_NORMALLY` (allows selecting real test payment cards or test responses).
4. Save changes.

### B. Upload AAB to Internal Testing Track
Google Play Billing APIs are **only active when an signed APK or AAB with matching `applicationId` and `versionCode` exists in a testing track**:
1. Build the release/debug bundle.
2. In Google Play Console, go to **Testing > Internal testing**.
3. Create a new release, upload the bundle, and release it.
4. Add the testers' email addresses under the **Testers** tab.
5. Copy the **Join on the web** or **Join on Android** opt-in URL and open it on the test Android device.

---

## 4. Testing All Purchase Flows (Production Runbook)

When opening the Shop in the app on a device enrolled in License Testing:

### 1. Success Flow (Instant)
- Tap "Buy" on `coins_100`.
- Google Play bottom sheet appears showing "Test card, always approves".
- Tap "Buy".
- Google Play returns `PURCHASED`.
- App displays `Verifying with Secure Server...`.
- Server validates token via Play Developer API, checks uniqueness, records transaction, and atomically credits 100 coins.
- Client calls `consumeAsync()` to make the product repurchasable.
- Gold celebration popup confirms +100 Coins added!

### 2. Pending Payment Flow (UPI / Delayed Approval)
- Tap "Buy" on `coins_500`.
- In test card options, select **Test card, approves after a few minutes (Pending)** or use Indian UPI test method.
- Complete flow in Play dialog.
- Google Play returns `PENDING`.
- **The app immediately displays**:
  `⏳ Payment Pending: Google Play is processing your transaction with your bank / UPI app. Coins will be credited automatically once confirmed.`
- **Zero coins are credited at this stage.**
- Once Play confirms the payment in the background, `reconcileUnconsumedPurchases()` or RTDN verifies and credits coins.

### 3. Cancelled Flow
- Tap "Buy" on `coins_1000`.
- Close or dismiss the Google Play bottom sheet.
- Play returns `USER_CANCELED`.
- App shows brief informative snackbar: "Purchase cancelled". No error thrown.

### 4. Duplicate Prevention Test
- Send the same `purchaseToken` twice to `/api/verify-purchase`.
- The server responds with `409 Conflict` (`DUPLICATE_TRANSACTION`).
- Coins are NOT credited a second time.

### 5. Interrupted Checkout / App Crash Recovery (Reconciliation)
- Complete a purchase while forcing the app to kill before the consume step.
- Re-open the app.
- `PlayBillingManager.reconcileUnconsumedPurchases()` automatically queries active purchases via `queryPurchasesAsync()`, sends the unconsumed purchase to the backend, and finishes consumption.
- The player never loses their purchase!
