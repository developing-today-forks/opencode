export function createFixtureProvider(options) {
    const captured = Object.fromEntries(Object.entries(options));
    return Object.assign((modelID) => ({ modelID, options: captured }), {
        options: captured,
        languageModel(modelID) {
            return { modelID, options: captured };
        },
    });
}
