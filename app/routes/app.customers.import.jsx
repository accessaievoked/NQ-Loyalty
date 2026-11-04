import { useRef, useState } from "react";
import { Form, useActionData, useNavigation } from "react-router";
import { requireStore } from "../services/auth.server";
import { importCustomers, importShopifyCustomers } from "../services/import.server";
import { MAX_ROWS } from "../lib/import-limits";

export const loader = async ({ request }) => {
  await requireStore(request);
  return null;
};

export const action = async ({ request }) => {
  const { store, admin } = await requireStore(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  if (intent === "shopify") return { kind: "shopify", ...(await importShopifyCustomers(store, admin, { after: String(form.get("after") || "") || null })) };
  if (intent === "csv") return { kind: "csv", ...(await importCustomers(store, String(form.get("csv") || ""))) };
  return { error: "Nothing to import" };
};

const SAMPLE = "email,first_name,last_name,points\nasha@example.com,Asha,Rao,1200\nrahul@example.com,Rahul,Mehta,350\n";
const n = (v) => new Intl.NumberFormat("en-IN").format(v);

function Result({ r }) {
  if (!r) return null;
  if (r.error) return <s-banner tone="critical">{r.error}</s-banner>;
  if (r.kind === "shopify") {
    return (
      <s-banner tone="success" heading="Shopify customers imported">
        <s-stack gap="small-300">
          <s-text>
            {n(r.created)} new accounts created, {n(r.existing)} were already members ({n(r.seen)} checked).
          </s-text>
          {r.next && (
            <Form method="post">
              <input type="hidden" name="intent" value="shopify" />
              <input type="hidden" name="after" value={r.next} />
              <s-text>There are more customers in Shopify. </s-text>
              <button type="submit" className="link-button">
                Continue importing
              </button>
            </Form>
          )}
        </s-stack>
      </s-banner>
    );
  }
  return (
    <s-banner tone={r.problems.length ? "warning" : "success"} heading="Import finished">
      <s-stack gap="small-300">
        <s-text>
          {n(r.created)} new accounts, {n(r.matched)} matched existing ones. {n(r.pointsAdded)} points given to {n(r.withPoints)} customers
          {r.alreadyImported ? `; ${n(r.alreadyImported)} had already received their imported balance and were left alone` : ""}.
        </s-text>
        {r.problems.length > 0 && (
          <s-stack gap="small-500">
            <s-text type="strong">
              {r.problems.length} thing{r.problems.length === 1 ? "" : "s"} to check
            </s-text>
            {r.problems.slice(0, 15).map((p, i) => (
              <s-text key={i} color="subdued">
                Line {p.line}: {p.reason}
              </s-text>
            ))}
            {r.problems.length > 15 && <s-text color="subdued">…and {r.problems.length - 15} more.</s-text>}
          </s-stack>
        )}
      </s-stack>
    </s-banner>
  );
}

export default function ImportCustomers() {
  const result = useActionData();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const fileRef = useRef(null);

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    setCsv(await f.text());
  };

  return (
    <s-page heading="Import customers" inlineSize="small">
      <style>{`.link-button{background:none;border:0;padding:0;color:#005bd3;text-decoration:underline;cursor:pointer;font:inherit}
        .csv-box{width:100%;box-sizing:border-box;min-height:150px;padding:10px 12px;border:1px solid #c9cccf;border-radius:10px;font:12.5px/1.5 ui-monospace,Menlo,Consolas,monospace;resize:vertical}
        .csv-pick{display:flex;align-items:center;gap:12px;flex-wrap:wrap}`}</style>

      <Result r={result} />

      <s-section heading="From your Shopify customers">
        <s-stack gap="base">
          <s-paragraph>
            Creates a rewards account for everyone already in your Shopify customer list, so they&apos;re counted as members from day one. Nobody gets
            points or a welcome email from this — it only sets up the accounts. Safe to run again.
          </s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="shopify" />
            <s-button type="submit" variant="primary" loading={busy && nav.formData?.get("intent") === "shopify" ? true : undefined}>
              Import Shopify customers
            </s-button>
          </Form>
        </s-stack>
      </s-section>

      <s-section heading="From a spreadsheet (CSV)">
        <Form method="post">
          <input type="hidden" name="intent" value="csv" />
          <s-stack gap="base">
            <s-paragraph>
              Bring over members and their point balances from another rewards app or your own sheet. The first row names the columns:{" "}
              <s-text type="strong">email</s-text> is required; <s-text type="strong">first_name</s-text>, <s-text type="strong">last_name</s-text> (or{" "}
              <s-text type="strong">name</s-text>) and <s-text type="strong">points</s-text> are optional. Up to {n(MAX_ROWS)} customers at a time.
              Running the same file twice never gives anyone their points twice.
            </s-paragraph>
            <div className="csv-pick">
              <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" onChange={onFile} hidden />
              <s-button onClick={() => fileRef.current?.click()}>Choose a CSV file</s-button>
              <s-text color="subdued">{fileName || "or paste it below"}</s-text>
              <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE)}`} download="loyalty-import-sample.csv">
                Download a sample
              </a>
            </div>
            <textarea className="csv-box" name="csv" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={SAMPLE} spellCheck={false} />
            <s-stack direction="inline" gap="small">
              <s-button type="submit" variant="primary" disabled={!csv.trim() || undefined} loading={busy && nav.formData?.get("intent") === "csv" ? true : undefined}>
                Import
              </s-button>
              {csv && (
                <s-button
                  onClick={() => {
                    setCsv("");
                    setFileName("");
                  }}
                >
                  Clear
                </s-button>
              )}
            </s-stack>
            <s-text color="subdued">
              Imported people start as unverified accounts: they claim their points by signing in with that email, and an imported address is never
              merged with a Shopify customer until Shopify confirms the email.
            </s-text>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}
