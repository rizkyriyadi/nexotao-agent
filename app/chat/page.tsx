import { redirect } from "next/navigation";

// The standalone chat/session surface has been retired. Every run now happens
// in the task/control-panel context, so /chat just forwards to the board.
export default function ChatPage() {
  redirect("/board");
}
