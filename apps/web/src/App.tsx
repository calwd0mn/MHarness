import styles from "./features/conversation/ConversationView.module.css";
import { useConversation } from "./session/use-conversation.ts";
import { SessionNavigation, ConversationHeader, MessageStream, Composer } from "./features/conversation/ConversationView.tsx";

/** 渲染会话页面并在卸载时释放订阅。 */
export function App() {
  const conversation = useConversation();
  return <main className={"shell " + styles.shell}><SessionNavigation {...conversation} /><section className={"conversation " + styles.conversation}><ConversationHeader {...conversation} /><MessageStream {...conversation} /><Composer {...conversation} /></section></main>;
}
