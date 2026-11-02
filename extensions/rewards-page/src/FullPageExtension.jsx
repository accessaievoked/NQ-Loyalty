import "@shopify/ui-extensions/preact";
import { render } from "preact";
import RewardsView from "../../shared/RewardsView.jsx";

// Target: customer-account.page.render — a full page in the account (add it to the menu in the
// customer accounts editor).
export default async () => {
  render(<Page />, document.body);
};

function Page() {
  return (
    <s-page heading="My Rewards">
      <RewardsView />
    </s-page>
  );
}
