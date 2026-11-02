import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { call } from "../../shared/rewards-client.js";

// Targets: customer-account.profile.block.render and customer-account.order-index.block.render —
// a small rewards card the merchant can place on the Profile and Orders pages.
export default async () => {
  render(<RewardsBlock />, document.body);
};

function RewardsBlock() {
  const [state, setState] = useState(null);
  const [failed, setFailed] = useState(null);

  useEffect(() => {
    call("state")
      .then((d) => setState(d.state))
      .catch((e) => setFailed(e?.message || "Couldn't reach the rewards app"));
  }, []);

  if (failed) {
    // Say why instead of vanishing — the editor's preview customer isn't a real one, so this is what
    // you'll see there; check the live account page for the real card.
    return (
      <s-section>
        <s-text color="subdued">Rewards aren't available right now: {failed}</s-text>
      </s-section>
    );
  }
  const me = state?.customer;

  return (
    <s-section>
      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
        <s-stack gap="small-300">
          <s-heading>My Rewards</s-heading>
          {!state ? (
            <s-text color="subdued">Loading…</s-text>
          ) : me ? (
            <>
              <s-text>You have <s-text type="strong">{new Intl.NumberFormat().format(me.points)} points</s-text> to spend.</s-text>
              {me.expiring && <s-text color="subdued">{me.expiring.points} points expire on {me.expiring.date}.</s-text>}
            </>
          ) : (
            <s-text color="subdued">Earn points on every order.</s-text>
          )}
        </s-stack>
        <s-button variant="primary" href="extension:rewards-page/">
          View rewards
        </s-button>
      </s-stack>
    </s-section>
  );
}
