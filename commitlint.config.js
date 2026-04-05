export default {
  rules: {
    "header-max-length": [2, "always", 72],
    "subject-empty": [2, "never"],
    "type-empty": [2, "never"],
    "type-case": [2, "always", "lower-case"],
    "subject-case": [0],
    "subject-full-stop": [2, "never", "."],
  },
  prompt: {
    questions: {
      type: {
        description: "Select the type of change",
      },
    },
  },
};
