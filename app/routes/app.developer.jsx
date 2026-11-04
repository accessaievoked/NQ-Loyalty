import { redirect } from "react-router";

// This page moved (/app/appearance/developer). Old bookmarks and links still work.
export const loader = ({ request }) => {
  throw redirect("/app/appearance/developer" + new URL(request.url).search);
};

export default function Moved() {
  return null;
}
