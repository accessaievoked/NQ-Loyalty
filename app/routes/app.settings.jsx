import { redirect } from "react-router";

// This page moved (/app/emails). Old bookmarks and links still work.
export const loader = ({ request }) => {
  throw redirect("/app/emails" + new URL(request.url).search);
};

export default function Moved() {
  return null;
}