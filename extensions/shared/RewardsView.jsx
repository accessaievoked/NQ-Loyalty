import { useEffect, useState } from "preact/hooks";
import { call, money, newRequestId } from "./rewards-client.js";

// The customer's rewards, drawn with Shopify's own components so it matches the account pages.

function Section({ heading, children }) {
  return (
    <s-section heading={heading}>
      <s-stack gap="base">{children}</s-stack>
    </s-section>
  );
}

function VariableReward({ reward, state, busy, onRedeem }) {
  const v = reward.variable;
  const balance = state.customer.points;
  const top = Math.floor(Math.min(balance, v.max || Infinity) / v.step) * v.step;
  const [pts, setPts] = useState(String(v.min));
  const n = Math.floor(Number(pts) || 0);
  const valid = n >= v.min && n <= top && n % v.step === 0;
  const worth = Math.floor(n / v.step) * v.unitValue;

  if (top < v.min) {
    return (
      <s-stack gap="small-300">
        <s-text type="strong">{reward.name}</s-text>
        <s-text color="subdued">{reward.description}. You need at least {v.min} points to use this.</s-text>
      </s-stack>
    );
  }
  return (
    <s-stack gap="small">
      <s-text type="strong">{reward.name}</s-text>
      <s-text color="subdued">{reward.description}{v.max ? ` · up to ${v.max} points` : ""}</s-text>
      <s-number-field
        label={`Points to use (${v.min}–${top}, in steps of ${v.step})`}
        value={pts}
        min={v.min}
        max={top}
        step={v.step}
        onInput={(e) => setPts(e.currentTarget.value)}
      />
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-text>
          {valid ? `${n} points = ${money(worth, state.shop.currency)} off` : `Enter between ${v.min} and ${top}, in steps of ${v.step}`}
        </s-text>
        <s-button variant="primary" disabled={!valid || busy || undefined} loading={busy || undefined} onClick={() => onRedeem(reward, n)}>
          Redeem
        </s-button>
      </s-stack>
    </s-stack>
  );
}

export default function RewardsView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [refCode, setRefCode] = useState("");

  const load = () =>
    call("state")
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const act = async (fn, okMessage) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fn();
      await load();
      setMessage({ tone: "success", text: okMessage(res) });
    } catch (e) {
      setMessage({ tone: "critical", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <s-banner tone="critical">{error}</s-banner>;
  if (!data) return <s-spinner accessibilityLabel="Loading your rewards" />;

  const { state } = data;
  const me = state.customer;
  if (!me) return <s-banner tone="warning">We couldn't find your rewards account. Please sign out and in again.</s-banner>;

  const redeem = (reward, points) =>
    act(
      () => call("redeem", { rewardId: reward.id, points, requestId: newRequestId() }),
      (r) => `Your code is ${r.code}. Copy it and paste it at checkout.`,
    );

  return (
    <s-stack gap="large">
      {message && <s-banner tone={message.tone} dismissible onDismiss={() => setMessage(null)}>{message.text}</s-banner>}

      <s-section heading="Your points">
        <s-stack gap="small-300">
          <s-heading>{new Intl.NumberFormat().format(me.points)} points</s-heading>
          <s-text color="subdued">Earned in total: {new Intl.NumberFormat().format(me.lifetime)}</s-text>
          {me.expiring && (
            <s-banner tone="warning">
              {me.expiring.points} points expire on {me.expiring.date}. Use them before then!
            </s-banner>
          )}
        </s-stack>
      </s-section>

      <Section heading="Redeem your points">
        {state.rewards.length === 0 && <s-text color="subdued">No rewards available yet.</s-text>}
        {state.rewards.map((r) =>
          r.variable ? (
            <VariableReward key={r.id} reward={r} state={state} busy={busy} onRedeem={redeem} />
          ) : (
            <s-stack key={r.id} direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-stack gap="small-300">
                <s-text type="strong">{r.name}</s-text>
                <s-text color="subdued">{r.cost} points · {r.description}</s-text>
              </s-stack>
              <s-button disabled={me.points < r.cost || busy || undefined} onClick={() => redeem(r)}>
                Redeem
              </s-button>
            </s-stack>
          ),
        )}
      </Section>

      <Section heading="Your discount codes">
        {state.coupons.length === 0 && <s-text color="subdued">No codes yet. Redeem a reward above to get one.</s-text>}
        {state.coupons.map((c) => (
          <s-stack key={c.code} direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-stack gap="small-300">
              <s-text type="strong">{c.code}</s-text>
              <s-text color="subdued">{c.rewardName}{c.expiresAt && c.status === "ACTIVE" ? ` · expires ${c.expiresAt}` : ""}</s-text>
            </s-stack>
            <s-badge tone={c.status === "ACTIVE" ? "success" : "neutral"}>{c.status === "ACTIVE" ? "Ready to use" : c.status === "USED" ? "Used" : "Expired"}</s-badge>
          </s-stack>
        ))}
        {state.coupons.some((c) => c.status === "ACTIVE") && <s-text color="subdued">Copy a code and paste it in the discount box at checkout.</s-text>}
      </Section>

      <Section heading="Ways to earn">
        {state.earn.map((e) => (
          <s-stack key={e.text + e.detail} gap="small-300">
            <s-text type="strong">{e.text}</s-text>
            <s-text color="subdued">{e.detail}</s-text>
          </s-stack>
        ))}
      </Section>

      {state.referral && (
        <Section heading="Refer a friend">
          <s-text>
            Your code: <s-text type="strong">{state.referral.code}</s-text>
          </s-text>
          <s-text color="subdued">
            {state.referral.invited} invited · {state.referral.rewarded} rewarded
            {state.referral.earned ? ` · ${state.referral.earned} points earned` : ""}
          </s-text>
          <s-text color="subdued">Share this link: {state.referral.link}</s-text>
          {state.referral.canApply && (
            <s-stack direction="inline" gap="small" alignItems="end">
              <s-text-field label="Have a friend's code?" value={refCode} onInput={(e) => setRefCode(e.currentTarget.value.toUpperCase())} />
              <s-button disabled={!refCode || busy || undefined} onClick={() => act(() => call("referral", { code: refCode }), () => "Referral code applied")}>
                Apply
              </s-button>
            </s-stack>
          )}
        </Section>
      )}

      <Section heading="Recent activity">
        {state.history.length === 0 && <s-text color="subdued">No activity yet.</s-text>}
        {state.history.slice(0, 15).map((h, i) => (
          <s-stack key={i} direction="inline" gap="base" justifyContent="space-between">
            <s-stack gap="small-300">
              <s-text>{h.label}</s-text>
              <s-text color="subdued">{h.date}{h.redeem ? ` · code ${h.redeem.code}` : ""}</s-text>
            </s-stack>
            <s-text type="strong">{h.points > 0 ? "+" : ""}{h.points}</s-text>
          </s-stack>
        ))}
      </Section>
    </s-stack>
  );
}
