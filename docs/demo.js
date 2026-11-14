const examples = {
  announcement: {
    task: "Launch announcement",
    note: "I have started the launch announcement and gathered references. I will share a draft tomorrow.",
    update: "The launch announcement is in progress. References are ready, and a first draft is planned for tomorrow.",
    statuses: ["Idea", "Drafting"],
  },
  homepage: {
    task: "Homepage review",
    note: "I reviewed the homepage and left feedback on the mobile layout. The design team can review it next.",
    update: "The homepage review is complete. Mobile layout feedback is ready for the design team.",
    statuses: ["In progress", "Ready for review"],
  },
};

const draft = document.querySelector("#draft");
const review = document.querySelector("#review");
const choice = document.querySelector("#example");
const result = document.querySelector("#result");
const heading = document.querySelector("#task");
const status = document.querySelector("#status");

choice.addEventListener("change", () => {
  document.querySelector("#note").value = examples[choice.value].note;
  review.hidden = true;
  result.textContent = "";
});

draft.addEventListener("submit", (event) => {
  event.preventDefault();
  const example = examples[choice.value];
  heading.textContent = example.task;
  document.querySelector("#update").value = example.update;
  status.replaceChildren(...example.statuses.map((name) => new Option(name)));
  status.selectedIndex = 1;
  review.hidden = false;
  result.textContent = "";
  heading.focus();
});

review.addEventListener("submit", (event) => {
  event.preventDefault();
  review.hidden = true;
  result.textContent = `Demo update confirmed for ${examples[choice.value].task}. Status set to ${status.value} in the demo.`;
  draft.querySelector("button").focus();
});
