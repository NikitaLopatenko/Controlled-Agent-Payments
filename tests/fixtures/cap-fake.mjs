export default function createAgent() {
  return {
    async fetch() { return new Response('fixture-resource', { status: 200 }); },
    async reconcile() { return { state: 'settled' }; },
  };
}
