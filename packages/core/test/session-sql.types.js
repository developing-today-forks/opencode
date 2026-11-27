const user = {
    text: "Hello",
    time: { created: 0 },
};
const assistant = {
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content: [],
    time: { created: 0 },
};
const invalid = {
    // @ts-expect-error Persisted message variants retain their field types.
    text: 42,
    time: { created: 0 },
};
void user;
void assistant;
void invalid;
export {};
