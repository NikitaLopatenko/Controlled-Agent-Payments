export default function createAgent() {
  return { async fetch() { return new Response('CAP_PRIVATE_LOG_SENTINEL invalid agent'); } };
}
