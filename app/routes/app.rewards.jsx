import { redirect } from "react-router";

// This page moved (/app/rules). Old bookmarks and links still work.
export const loader = ({ request }) => {
  throw redirect("/app/rules" + new URL(request.url).search);
};

export default function Moved() {
  return null;
}