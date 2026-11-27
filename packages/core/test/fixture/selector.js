export function fakeSelectorSdk(calls) {
    const make = (method) => (id) => {
        calls.push(`${method}:${id}`);
        return { modelId: id, provider: method, specificationVersion: "v3" };
    };
    return {
        responses: make("responses"),
        messages: make("messages"),
        chat: make("chat"),
        languageModel: make("languageModel"),
    };
}
