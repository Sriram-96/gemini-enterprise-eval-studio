# Gemini Enterprise Eval Studio

<div align="center">
  <img src="src/assets/logo.svg" alt="Gemini Enterprise Eval Studio Lockup" />
</div>

## Overview

Gemini Enterprise Eval Studio is an evaluation framework designed to execute
stateless API calls against Gemini Enterprise for E2E evaluation.
It enables customers to run batch evaluations, compare baselines, measure
streaming latency metrics (TTFT, TTFA, TTLT, Grounding Latency, Tool Execution
Latency), and define custom metrics using auto-grader rubrics or programmatic
evaluators.

## Motivation

Quality assurance is a major friction point for Gemini Enterprise
implementations. Enterprise customers require secure, client-side tools to
evaluate model performance, accuracy, and streaming latency on custom
collections without relying on externally hosted evaluation platforms that
violate data privacy policies.

## Key Features

-   **Client-Side Stateless Execution**: Direct API communication using end-user
    tokens, ensuring data privacy.
-   **Latency Telemetry Capture**: Calculate and expose Time to First Token
    (TTFT), Time To First Answer Token (TTFA), and Time To Last Token (TTLT) in seconds (s).
-   **Dual Metric Definition**: Support for both LLM-as-a-Judge rubrics and
    programmatic evaluator modules.
-   **Full Trace Capture**: Every row records the documents the agent cited,
    the data stores and connectors they came from, the tools it ran and its
    thinking, so a tester can confirm *how* an answer was reached and not only
    that it sounded plausible. See [Verifying Retrieval](#verifying-retrieval).
-   **Per-Row Agent Targeting**: An optional `agent` column sends individual
    rows to a named custom agent of the engine instead of its default
    assistant, so one upload can compare the two on the same queries. See
    [Evaluating a custom agent](#evaluating-a-custom-agent).

## Data Privacy and Governance

To ensure security and compliance with enterprise data policies, Gemini
Enterprise Eval Studio is designed with a strict client-side, stateless
architecture:

1.  **GCP Tenant Isolation**: The tool operates entirely within the user's
    Google Cloud Platform (GCP) tenant. All computations, evaluation runs, and
    data storage occur within your controlled environment.
2.  **No Google Data Collection**: Google does not collect, store, or have
    access to your customer data, queries, evaluation inputs, or evaluation
    results processed by this tool. There are no telemetry pings, usage analytics,
    or error reporting sent to any Google-owned project.
3.  **Governing Agreements**: Any data handling and API calls made by the tool
    are governed solely by the customer's existing agreements with Google Cloud
    for the specific APIs used (e.g., Vertex AI APIs).
4.  **Token Storage & Firestore Retention Policy by Auth Provider**:
    - **SAML**: No credentials or tokens are stored in Firestore. SAML authentication assertions are processed statelessly without storing refresh tokens.
    - **Google Identity & 3P OIDC**: If server-side token storage in Firestore is enabled (`firestore_config`), user refresh tokens are stored in your GCP project's Firestore database. Administrators can configure `firestore_config.ttlSeconds` to control how long refresh tokens remain valid/stored before users are required to sign in again (defaults to 7 days).
    - **Firestore Purge Latency**: Expired tokens in Firestore are automatically purged under a TTL policy, which typically deletes expired documents within 24–72 hours of expiration. Please ensure this retention window satisfies your compliance requirements.

## Prerequisites & Setup

Gemini Enterprise Eval Studio supports two operational modes depending on your environment:

- **Auth Mode (Production / Team Deployment)**: Users authenticate via Google Workspace (Google Identity) or external Identity Providers (OIDC / SAML) using Workforce Identity Federation. Sessions are encrypted, and server-side refresh token persistence in Firestore is supported for **Google Workspace (`google_identity`)** and **OIDC (`3p_oidc`)** providers to extend sessions beyond 1 hour. Note: **SAML (`3p_saml`) providers do not support refresh tokens**; SAML sessions expire after 1 hour and require re-authentication.
- **No-Auth Mode (Client-Side / Quick Testing)**: The application runs as a **frontend-only site** without a backend server. Users authenticate by directly inputting a temporary Google Cloud access token into the UI.

### 1. Common Prerequisites (API Enablement)

In the Google Cloud Console, navigate to **APIs & Services > Library** and enable the following APIs for your GCP project:
1. **Agent Platform API** (`agentplatform.googleapis.com`)
2. **Discovery Engine API** (`discoveryengine.googleapis.com`)

### 2. Auth Mode Setup

1. **Identity Provider Credentials**:
   - **Google Workspace (`google_identity`)**: [Create an OAuth 2.0 Client ID](https://cloud.google.com/iam/docs/creating-managing-oauth-clients) in your Google Cloud Console. Set the Authorized Redirect URIs to include `http://localhost:3000/auth/callback` (or your production domain).
   - **Third-Party Providers (`3p_oidc` / `3p_saml`)**: [Set up Workforce Identity Federation (WIF)](https://cloud.google.com/iam/docs/workforce-identity-federation) in GCP by creating a Workforce Pool and Provider. Register an OIDC or SAML application in your external IdP (e.g., Okta, Entra ID) and set the callback URI to `http://localhost:3000/auth/callback`.
     > **Security Recommendation**: Configure attribute conditions or conditional access policies in your Workforce Identity Federation (WIF) Provider or external IdP to restrict access strictly to authorized business users and prevent unauthorized login by non-business accounts.
2. **Secret Manager (Optional but recommended)**:
   - Store your OAuth client secret and session encryption key in GCP Secret Manager and use their URIs in `config.json`.
3. **Application Configuration (`config.json`)**:
   - Create a `config.json` file in the root directory based on `config.json.example`.
   - Configure `session_config.encryption_key_secret` (can be a 32-character string for local dev) and your `auth_providers` array.
   - *(Optional)* Configure `firestore_config` to enable server-side refresh token storage in Firestore (requires a database created in **Firestore Native mode**), extending user sessions beyond 1 hour for Google Identity and OIDC providers.
   - *(Optional)* Configure `trusted_hosts` array to allowlist custom hostnames for authentication redirects.

### 3. No-Auth Mode Setup

In No-Auth Mode, the application operates as a standalone frontend-only web application without requiring a backend server or identity provider configuration.

1. Obtain a temporary Google Cloud access token by running the following command in your terminal (or open Cloud Shell using the terminal icon on the top right of the Google Cloud Console):

    ```sh
    gcloud auth print-access-token
    ```
    *Note: Access tokens are short-lived and will need to be refreshed periodically.*

2. Input the generated access token directly into the configuration screen in the application's UI.

    <p align="center">
      <img src="src/assets/cloud_shell_icon.png" alt="Cloud Shell Terminal Button" />
    </p>

## Running Locally

To run the application locally using `npm`, first install dependencies:

```sh
npm ci
```

Then start the server in either **Auth Mode** (full stack) or **No-Auth Mode** (client-side frontend only):

- **Running in Auth Mode (Full Stack with Backend Express Server)**:
  ```sh
  npm run start:auth
  ```
  This starts both the Node.js Express backend server (default port 3000) and the Angular frontend development server configured to proxy API requests to the backend.

- **Running in No-Auth Mode (Client-Side Frontend Only)**:
  ```sh
  npm run start:no-auth
  ```
  By default, the frontend listens on port 4200.

## Verifying Retrieval

A confident answer is not evidence of correct retrieval: an agent that cites
the wrong document, or none, can still sound right. Every evaluation run
therefore captures the journey behind each answer, not just its text.

**In the results table**, each row gains a `Sources` and a `Connectors` column,
plus a **Trace** button opening an inspector that shows, in the order the work
happened: the model's thinking, the tools it ran, every document it cited (with
title, uri, connector and grounding score), and which claim in the answer rests
on which document.

**In the exports**, the CSV carries flattened `citedSources`,
`citedDataStores`, `citedConnectors`, `toolCalls` and `maxGroundingScore`
columns, and **Download traces (JSONL)** writes one record per row holding the
verbatim `streamAssist` stream — everything the API sent, for auditors who need
to replay a run rather than skim it.

**As a metric**, add an `expected_sources` column to your query set and select
the **Source Attribution** scorer. It fails any row whose answer did not cite
what you expected, so retrieval regressions surface the same way answer-quality
regressions already do. See
[src/app/scoring/README.md](src/app/scoring/README.md) for the matching rules,
and [testdata/connector-fixtures/](testdata/connector-fixtures/) for a worked
example: six synthetic documents to upload to a connector and a query set whose
answers are impossible to guess without retrieving them.

## Evaluating a custom agent

By default every row is answered by the engine's own default assistant. To send
a row to one of the engine's custom agents instead, add an `agent` column to
your query set and put the agent's **id** in it:

```csv
query,golden,agent
"What is the per diem for Zurich?","65 CHF per day",
"Triage INC-4471","Page the storage on-call",dc-triage
```

The first row has an empty cell, so it goes to the default assistant exactly as
before; the second is served by the `dc-triage` agent. A query set with no
`agent` column at all behaves as it always has, so existing files need no
change.

**Use the id, not the resource name.** Gemini Enterprise identifies an agent by
a resource name of the form

```
projects/{project}/locations/{location}/collections/{collection}/engines/{engine}/assistants/{assistant}/agents/{agent}
```

and the column takes only that last `{agent}` segment — not the whole path. In
the Gemini Enterprise console it is the id shown on the agent's page, and it is
also the tail of the URL when the agent is open. Ids take several shapes in
practice: built-in agents have readable ids such as `deep_research`, while
agents created in the console are identified by a long number such as
`7988451370136689726`. Pasting a full resource name is the easiest mistake to
make, so the app checks the column before the run starts and, if it finds one,
tells you which segment to use instead. Nothing is sent until the whole column
is valid, so that mistake costs a message rather than a run.

> **Check the id against the console before a long run.** `streamAssist` does
> not reject an agent id that names nothing: it answers with **HTTP 200 from
> the engine's default assistant**. A mistyped but well-formed id therefore
> produces a complete, plausible, fully scored run that simply did not test the
> agent you meant, and neither this app nor the API can tell you so. The
> surest check is a single-row query set: ask *"Who are you?"* with the agent
> id filled in, and confirm the answer is the agent's and not the default
> assistant's.

To list the ids available on an engine, with an access token for the project:

```sh
curl -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://discoveryengine.googleapis.com/v1alpha/projects/PROJECT/locations/global/collections/default_collection/engines/ENGINE/assistants/default_assistant/agents"
```

**One agent per conversation.** The turns of a multi-turn row group (rows
sharing a `conversation_id`) run against a single Assistant session, and
switching the serving agent part-way through one is not a defined operation.
Every turn of a conversation must therefore name the same agent — or all leave
it empty. A group that disagrees is rejected before the run starts.

The agent that served each row is reported back: the results table gains an
**Agent** column, the CSV export carries it as `agentId`, and the JSONL trace
export records it alongside the session and turn ids, so a mixed run stays
attributable row by row. The column is present whether or not any row used a
custom agent, and is empty for the rows the default assistant answered.

Because the agent is chosen per row, one upload can compare a custom agent
against the default assistant on the same queries: duplicate each query, leave
the `agent` cell empty on one copy and fill it on the other, and read the two
scores off the same table.

## Reproducing reported bugs

[testdata/customer-bug-fixtures/](testdata/customer-bug-fixtures/) holds a query
set built to reproduce specific customer-reported defects rather than to
measure general quality: multi-turn document context loss, thinking traces that
misread domain acronyms, connector fallbacks that retrieve a superseded file,
knowledge base documents described as user uploads, and output-hygiene defects
such as duplicated trailing tokens and leaked HTML. It runs as a single upload
with the default auto-rater instruction, every row carries the backlog number it
came from and a `check` column naming what decides it, and the README there is
explicit about which of these bugs the tool can score automatically and which
need a column read by hand.

## Running with Docker

Gemini Enterprise Eval Studio includes a multi-stage `Dockerfile` that packages both the compiled Angular SPA and the Node.js Express backend server into a single production container image.

### 1. Build the Image
```sh
docker build -t gemini-enterprise-eval-studio .
```

### 2. Run the Container
```sh
docker run -d \
  -p 8080:8080 \
  -v $(pwd)/config.json:/app/config.json \
  --name eval-studio \
  gemini-enterprise-eval-studio
```

### Configuration Options:
- **Port Mapping**: Map the container to any host port using `-p <host_port>:8080` (e.g. `-p 3000:8080` to access the application at `http://localhost:3000`).
- **Port Environment Variable**: If you wish to change the container's internal listening port, pass `-e PORT=<port>` (defaults to `8080`).
- **Configuration File**: Mount your `config.json` into `/app/config.json` via `-v` volume mount, or specify a custom path inside the container using `-e CONFIG_PATH=/path/to/config.json`.

### 3. Deploy to Cloud Run
You can deploy the application directly to Cloud Run from source. Cloud Run will automatically build the container image using the `Dockerfile` and deploy the service:

```sh
gcloud run deploy gemini-enterprise-eval-studio \
  --project=<PROJECT_ID> \
  --region=<REGION> \
  --source=.
```

## Uninstall and Resource Deletion

To completely uninstall Gemini Enterprise Eval Studio and delete all associated data and resources from your GCP project:

1. **Stop or Remove Application Deployment**:
   - Terminate the local application server or container process. To verify the backend server is down, ping the `/healthz` endpoint (e.g., `curl http://localhost:3000/healthz`); it should fail to connect.
   - If deployed to a cloud environment (e.g., Cloud Run, App Engine), delete the deployed service or instance.

2. **Delete Firestore Session Data**:
   - If Firestore token storage was enabled (`firestore_config`), navigate to **Firestore** in the Google Cloud Console and delete the session/token collections.
   - Alternatively, delete the Firestore database instance if it was created solely for this tool. Note: If relying on TTL expiration rather than manual deletion, expired documents are automatically purged by Firestore within 24–72 hours.

3. **Remove Identity Provider Credentials & WIF**:
   - Delete the OAuth 2.0 Client ID under **APIs & Services > Credentials** in your GCP project.
   - If Workforce Identity Federation (WIF) was configured, delete the Workforce Pool and Provider under **IAM & Admin > Workforce Identity Pools**.

4. **Delete Stored Secrets & Disable APIs (Optional)**:
   - Delete any stored secrets in **Secret Manager** (such as OAuth client secrets or session encryption keys).
   - Disable the Agent Platform API and Discovery Engine API under **APIs & Services > Enabled APIs & Services** if they are no longer needed.
