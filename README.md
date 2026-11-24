# PEMS implementation model

PEMS serves the candidate interface and the submission API from a single Node.js 24 application. The existing GitHub Pages demo is a separate static build. The repository can run the included integration test through GitHub Actions.

## Run the model

From the project directory with Node.js 24 LTS installed:

```sh
npm ci
npm test
npm start
```

Open http://127.0.0.1:3000. Use fictional Emirates ID `000000000000001` or `000000000000002`. Save records using the forms and select **Submit evidence**. The application reports the attempt reference and saves the PDF in `submissions/`. It logs recordings as metadata. Video files stay in the designated exercise storage location.

The included CSV is a development fixture. A private import file can replace it by setting `PEMS_ROSTER` before startup. Use UTF-8 CSV with headers `emirates_id,name`, preserve IDs as text, and restart after changing the file. IDs accept 15 digits with optional spaces or hyphens. Keep real CSVs outside public folders and source control.

## Azure hosting configuration

Deploy the project with Azure App Service and Node.js 24. Install dependencies with `npm ci --omit=dev` and start it with `npm start`. Keep the independently deployed GitHub Pages demo separate from the implementation.

| Setting | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PEMS_ORIGIN` | Exact public HTTPS origin without a trailing slash |
| `PEMS_ROSTER` | Absolute path to a restricted, mounted server-side CSV |
| `PEMS_SECRET` | Stable random server secret of at least 32 characters, configured securely and kept across deployments |
| `PEMS_ASSESSMENT` | Unique assessment event or case reference. An ID gets one attempt per value. Change it for a new event. |
| `PEMS_BLOB_ENDPOINT` | HTTPS storage account endpoint |
| `PEMS_BLOB_CONTAINER` | Name of the private submission container |

The app uses the host's system-assigned managed identity for Blob Storage. Allow it to create blobs and read blob properties for receipts within the submission container. The backend saves PDFs by opaque attempt reference. The server origin, roster, and storage configuration stay private. Authorised staff retrieve PDFs with their Azure access.

## Limits of this first model

- Local API and PDF generation are exercised with fictional candidates. The Azure write path requires an Azure test host and managed identity.
- Run one application instance for this model. Sessions are in memory and sign-in is required again after a restart. Saved drafts remain on the assessment browser by attempt reference. The signed-in interface separates drafts from different attempts. Use separate browser profiles or reset assessment devices between candidates when handling real information.
- An Emirates ID matches a roster entry. Identity confirmation is supervised. Before using the real roster, confirm the College's network and candidate access controls with IT.
- Before live use, review the report layout with staff, including representative Arabic names where applicable, and verify candidate isolation, staff retrieval, and upload retry on the assessment network.
