# Claude Agent SDK [Full Workshop] — Thariq Shihipar, Anthropic

Source URL: https://www.youtube.com/watch?v=TqC1qOfiVcQ
Channel: AI Engineer (https://www.youtube.com/channel/UCLKPca3kwwd-B59HNr-_lvA)
Uploader: AI Engineer
Upload date: 20260105
Duration: 112:25
Date observed: 2026-05-17
Capture method: `yt-dlp --dump-json --skip-download` plus auto-generated English VTT subtitles.
Source status: YouTube metadata + auto captions. Treat transcript as machine-generated and verify quotes against video before using on slides.

## Why this matters for CascadiaJS 2026

This workshop is directly relevant to the talk's harness-engineering thesis because it discusses the Claude Agent SDK, agent loops, tools, prompts, skills, context engineering, permissions, and monitoring. The exact claims below should be verified from the transcript/video before being used publicly.

## Description from YouTube

```text
Learn to use Anthropic's Claude Agent SDK (formerly Claude Code SDK) for AI-powered development workflows!

https://platform.claude.com/docs/en/agent-sdk/overview
https://x.com/trq212

**AI Summary**
This workshop by Thariq Shihipar (Anthropic) details the architecture and implementation of the **Claude Agent SDK**. The session moves from high-level theory—defining "agents" as autonomous systems that manage their own context and trajectory—to a live-coding demonstration. Shihipar builds an agent "Harness" from scratch, implementing the core **Agent Loop** (Context  Thought  Action  Observation), integrating the **Bash tool** for general computer use, and demonstrating **Context Engineering** via the file system to maintain state across long tasks.

**Timestamps**

00:00 Introduction: Agenda and the "Agent" definition
05:15 The "Harness" concept: Tools, Prompts, and Skills
10:10 Live Coding Setup: Initializing the Agent class and environment
15:45 implementing the "Think" step: Getting the model to reason before acting
25:20 The Agent Loop: connecting `act`, `observe`, and `loop`
33:10 Tool Execution: Handling XML parsing and tool inputs
42:00 The "Bash" Tool: Giving the agent command line access
49:30 Safety & Permissions: "ReadOnly" vs "ReadWrite" file access
58:15 Context Engineering: Using `ls` and `cat` to build dynamic context
01:05:00 The "Monitor": Viewing the agent's thought process in real-time
01:12:45 Handling "Stuck" States: Feedback loops and error correction
01:21:20 Multi-turn Complex Tasks: Building a "Research Agent" demo
01:35:10 Refactoring patterns: "Hooks" and deterministic overrides
01:48:39 Q&A: Reproducibility, helper scripts, and non-determinism
01:50:31 Q&A: Strategies for massive codebases (50M+ lines)
01:52:00 Closing remarks and future SDK roadmap

* **Evolution of AI Capabilities:** Shihipar argues we are shifting from **LLM Features** (categorization, single turn) to **Workflows** (structured, multi-step chains like RAG) to **Agents**. He defines agents as systems that *"build their own context, decide their own trajectories, and work very autonomously"* rather than following a rigid pipeline.
* **The Claude Agent SDK Architecture:** The SDK is built directly on top of **Claude Code** because Anthropic found they were *"rebuilding the same parts over and over again"* for internal tools.
* **The Harness:** A robust agent requires more than just a model; it needs a "Harness" containing Tools, Prompts, a **File System**, Skills, Sub-agents, and Memory.
* **Opinionated Design:** The SDK bakes in lessons from deploying Claude Code, specifically the "opinion" that general computer use (Bash) is often superior to bespoke tools.


* **The Power of the Bash Tool:** A key technical insight is that the **Bash tool** is often the most powerful tool for an agent. Instead of building custom tools for every action (e.g., a specific API wrapper for a file conversion), giving the agent access to the shell allows it to use existing software (like `ffmpeg`, `grep`, or `git`) to solve problems flexibly, similar to how a human developer works.
* **Context Engineering:** Shihipar introduces the concept of **Context Engineering** via the file system. Instead of just "Prompt Engineering," the agent uses the file system to manage its state and context.
* **Files as Memory:** The agent can write to files to "remember" things or create its own documentation (e.g., `CLAUDE.md`) to ground future actions.
* **Verification:** The file system serves as a ground truth for the agent to verify its work (e.g., checking if a file was actually created).


* **The Agent Loop & Intuition:** Building a successful agent loop is described as *"kind of an art or intuition"*. The loop generally follows a **Gather Context  Take Action  Verify Work** cycle. Shihipar emphasizes that this loop allows the agent to self-correct, a capability missing from rigid workflows.
* **Strategies for Determinism (Hooks):** During the Q&A, a technique for controlling agent behavior is discussed: **Hooks**.
* If an agent hallucinates or skips a step (e.g., guessing a Pokemon stat instead of checking a script), a hook can intercept the response and inject feedback: *"Please make sure you write a script, please make sure you read this data."*
* This enforces rules like "read before you write" without retraining the model.


* **Scaling to Large Codebases:** For massive codebases (50M+ lines), standard tools like `grep` or basic context window stuffing fail.
* **Semantic Search Limitations:** Shihipar notes that while semantic search is a common solution, it is *"brittle"* because the model isn't trained on the specific semantic index.
* **Solution:** He recommends good **"Claude MD"** files (context files) and starting the agent in a specific subdirectory to limit scope, rather than trying to index the entire 50M lines at once.
```

## Transcript

```text
[music]
>> Okay, yeah, thanks for joining me. I I'm
still on West Coast time, so it feels
like I'm doing this at
like 7:00 a.m.
Uh so, yeah, but
um glad to talk to you about the Claude
Agent SDK. So, um yeah, I I think like
this is going to be like a rough agenda
of what we're going to talk about. We're
going to talk about like what is the
Claude Agent SDK, why use it? There's so
many other agent frameworks, what is an
agent, what is an agent framework? Um
How do you design an agent uh using the
Agent SDK or or just in general? Um
and then I'm going to do some like live
coding Claude is going to do some live
coding on prototyping an agent. Um and
uh got some starter code, but
uh yeah, I I the whole
goal of this is like, you know, we got 2
hours, we can be super collaborative,
ask questions.
Um
this is also going to be not like a
super canned demo in the sense that like
we're going to be like thinking through
things live, you know, I'm not going to
have all the answers right away.
Um and I think that'll be a good way of
like
building an agent loop, I think it's
like really much very much like kind of
an art or intuition. So,
um
But yeah, before we get started, just
curious a show of hands like how many
people have heard of the Claude Agent
SDK or have Okay, great.
Cool. And how many of like used it or
tried it out?
Okay, awesome. Okay, so pretty good show
of hands. Um
yeah, so I'll I'll just get started on
like the like, you know, overview on
agents. I I think that like this is I I
I think something that people have
[clears throat] seen before, but I think
it still is taking some time to like
really sink in
uh how AI features are evolving, you
know, so I think like when GPT, you
know, 3 came out, it was really about
like single LM features, right? You're
like, "Oh, well, like, hey, can you
categorize this? Like return a response
in one of these categories."
Um and then we've gotten more like
workflow-like things, right? Hey, like,
"Can you like take this email and label
it?" Or like, "Hey, here's my code base,
like index for your rag. Can you give me
like the next completion or the next
um
the next file to edit, right?" And so,
that's what we'd call like a workflow
where you're very like structured.
You're like, "Hey, like, given this
code, give me code back out, right?" And
now we're getting to agents, right? And
uh
like the canonical agent we have is
Claude Code, right? Claude Code is a
tool where you don't really tell it we
don't restrict what it can do really,
right? You're just talking to it in
text, and it will take a really wide
variety of actions, right? And so,
agents
uh build their own context, like decide
their own trajectories, are working very
very autonomously, right? And so,
uh yeah, and I think like as the future
goes on, like agents will get more and
more autonomous
um and we
uh yeah, I think it's like we're kind of
at a great point where we can start to
build these agents.
Um they're not perfect, you know, but
it's definitely like the right time to
get started. So,
um yeah, Claude Code, I'm sure many of
you have have tried or used.
Um it is yeah, I think the first true
agent, right? Like the first uh time
where I saw an AI working for like 10,
20, 30 minutes, right? So,
um
yeah, it's it's a coding agent. And uh
the Claude Agent SDK is actually built
on top of Claude Code. And
uh the reason we did that is because
um basically we found that when we're
building agents at Anthropic, we kept
rebuilding the same parts over and over
again. And so, to to give you a sense of
like what that looks like, of course,
there are the models to start, right? Um
and then in the harness, you've got
tools, right? And that's like sort of
the first obvious step, like let's add
some tools to this harness. And later
on, we'll give an example of sort of
like trying to build your own harness
from the scratch, too, and and what that
looks like and and how challenging it
can be, but tools are not just like your
own custom tools. They might be tools
that track the their file system, like
with Claude Code. Um did the volume just
go up or were they not holding it close
enough?
>> [laughter]
>> Okay. Save some echo. Anyways, um got
tools, tools you run in a loop, and then
you have the prompts, right? Like the
core agent prompts, the
um the the prompts for the transitions,
like that.
Uh and then finally, you have the file
system, right? And or not finally, but
you have the file system. The file
system is a way of
context engineering that we'll talk more
about later, right? And I think like I
one of the key insights we had through
Claude Code was thinking a lot more
through
the like context not just a prompt, it's
also the tools, the files, the scripts
that it can use. Um
and then there are skills, which we've
like rolled out recently, and uh we can
talk more about skills uh
um if that's interesting to you guys as
well. Um and then yeah, things like uh
sub agents, uh web search, you know,
like um
like research, compacting, hooks,
memory. There are all these like other
things around the harness as well. Um
and uh it ends up being quite a lot. So,
the Claude Agent SDK is all of these
things packaged up for you to use,
right?
>> [clears throat]
>> Um and yeah, you have your application.
So, I I think like
uh to give you a sense of uh
yeah, to give you a sense of like
maybe why the Claude Agent SDK is
um
yeah, like like so yeah, people are
already building agents on the SDK. A
lot of software agents,
uh you know, software reliability,
security, incident triaging, bug
finding,
um site and dashboard builders, if
you're
these are extremely popular. If you're
using it, you should absolutely use the
SDK.
Um
MS Office agents, if you're doing any
sort of office work, tons of examples
there. Um
got some like, you know, legal, finance,
health care ones.
Um
So, yeah, there are tons of people
building on top of it. Um I want to Oh
yeah, okay. So,
why the Claude Agent SDK, right? Like
why did we do it this way? It's why did
we build it on top of Claude Code? And
we realized basically that as soon as we
put Claude Code out, yeah, the engineers
started using it, but then the finance
people started using it, and the data
science people started using it, and the
marketing people started using it. And
yeah, I think it just like
it we just realized that people were
using Claude Claude Code for non-coding
tasks.
We felt and and as we were building, you
know, non-coding agents, we kept coming
back to it, right? And so,
um
it's a like and we'll go more into why
that just works, why we could use Claude
Code for non-coding task. Uh spoiler
alert, it's like the bash tool.
Um but yeah, it's uh it it it was
something that we saw as an emergent
pattern that we want to use, and we
built our agents on top of it, right?
And uh these are lessons that we've
learned from deploying Claude Code that
we've sort of baked in. So,
uh tool use errors or compacting or
things like that. Stuff that is like
very can take a lot of scale to find,
you know, like what are the best
practices, we sort of baked into the
Claude Agent SDK.
Um as a result, we have a lot of strong
opinions on the best way to build
agents.
Uh like I think the Claude Agent SDK is
quite opinionated. We'll I'll talk over
some of these opinions and and why like
uh why we chose them, right? Um
But yeah, one of the big opinions is the
bash tool is the most powerful agent
tool. So, okay, um what what are like
what I would describe as the Anthropic
way to build agents, right? And I'm I'm
not saying that you can only build
agents using the API this way, right?
But this is like um if you're using our
opinionated stack on the Agent SDK, what
is it, right? So, roughly Unix
primitives, like the bash and file
system, and you know, we're going to go
over like prototyping an agent using
Claude Code. And my goal is really to
sort of show you what that looks like in
real time, right? Like why is bash
useful? Why is the file system useful?
Why not just use tools?
Um
Yeah, agents uh I mean, you can also
make workflows. I'll talk about that a
little later. The agents build their own
context. Um thinking about code
generation for non-coding. Um
Like we use code gen to generate docs,
query the web, like do data analysis,
take uh unstructured actions. So, um
there's a lot of like uh this can be
pretty counterintuitive to some people.
And again, with the the like prototyping
session, we'll we'll go over how to use
code generation for coding agents. Um
And yeah, every agent has a container or
is hosted locally because this is Claude
Code, uh it needs a file system, it
needs bash, it needs to be able to
operate on it. And so, it's a very very
different architecture. I'm not planning
to talk too much about the architecture
today, but we can at the end if that's
what people are interested in in or
sorry, by architecture, I mean hosting
architecture, like how do you host an
agent? And like uh what are best
practices there? Happy to talk about
that at the end. Um,
>> [clears throat]
>> yeah. So,
well, let me pause there cuz I feel like
I covered a lot already. Any questions
so far on the agent SDK, agents, um,
yeah, like what you get from it.
Can you Can you explain what code
generation for non-coding means exactly?
Yeah. Um, this is um,
like, basically, when you ask Claude
Code to do a task, right? Like, let's
say that you ask it to
uh, find the weather in San Francisco
and like, you know, tell me what I
should wear or something, right? Like,
uh,
what it might do is it might start
writing a script
uh, to fetch a weather API, right? And
then start like, maybe it wants it to be
reusable, like maybe you want to do this
pretty often, right? So, it might fetch
the weather API and then get the like,
maybe even get your location
dynamically, right? Based on your IP
address, and then it will like,
um,
you know, check the weather and then
maybe like call out to like a sub-agent
to give you recommendations. Maybe
there's an API for your closet or
wardrobe, right? So, like so, that's an
example. I I think that like it's kind
of um, for any single example, we can
talk over how you might use code code
gen. Uh, a lot of it is like composing
APIs is like the high-level way to think
about it. Yeah.
Uh, yeah, and
>> [clears throat]
>> Yeah. Uh, workflow versus agent, uh,
like for repetitive task or, you know,
like a process or business process that
is always the same, do you will still
prefer build an agent versus a
fully deterministic workflow? Yeah, so
we do have
Oh, sure, yeah, yeah. Um, so the
question The question was about
workflows versus agents and would you
still use the Claude agent SDK for
workflows? Is that right? Um, yes. And
so And so,
uh, I mean, we
I just
we just sort of tell you what we do
internally, basically. And what we do
internally is we've done a lot of like
GitHub automations and Slack automations
built on the Claude agent SDK, so uh,
you know, we have a bot that triages
issues when it comes in. That's a pretty
workflow-like thing, but we've still
found that, you know, in order to triage
issues, we wanted it to be able to clone
the code base and sometimes spin up a
Docker container and test it and things
like that. And so, it's still ends up
being like a very like there's a lot of
steps in the middle that need to be
quite three-flowing, um, and then you
like get structured output at the end.
So,
um,
yes.
All right, I'll take one more question
and then keep going. So, yeah, in the
blue. Yeah, uh, so could you talk about
security and guardrails? Like, if if,
you know, you're using Claude agent SDK
and, you know, you're leaning towards
using bash as the, you know,
all-powerful generic tool, then is the
onus on uh,
building the the agent builder to make
sure that, you know, you're preventing
against like common attack vectors or is
that something that the model is is is
doing
Yeah, so I I think this is sort of like
the Swiss cheese Oh, yeah, sorry. Yeah,
so the question was uh, permissions on
the bash tool, right? Or like, how do
you think about permissions and
guardrails? The like and like, when
you're giving the agent this much power
over, you know, your its environment on
the computer, how do you make sure it's
aligned, right? And so, the way we think
about this is uh, what we call it the
Swiss cheese defense, right? So, like
there is um, like on every layer some
defenses and together we hope that it
like blocks everything, right? So,
obviously on the model layer, uh, we do
a lot of
um, alignment there. We actually just
put out a really good paper on reward
hacking. Super recommend you check that
out. Um,
so like definitely I think Claude models
like we try and make them very very
aligned, right? And uh, so, yeah,
there's a model alignment behavior. Then
there is like the harness itself, right?
And so, we have a lot of like
permissioning and prompting,
um, and
uh,
like we do uh, AST pass parser on the
bash tool, for example, so we know um,
fairly reliably like what the bash tool
is actually doing and definitely not
something you want to build yourself.
Um, and then finally,
the last layer is sandboxing, right? So,
like let's say that and someone has
maliciously taken over your agent, what
can it actually do? Uh, we've included a
sandboxing like where you can sandbox
network request um, and sandbox
uh, file system operations outside of
the file system. And so,
uh, yeah, ultimately that's what they
call like the lethal trifecta, right? Is
like um,
like the ability to like execute code in
environment, change the file system, um,
exfiltrate the code, right? I think I'm
getting the lethal trifecta a little bit
wrong there, but like the idea is
basically like if they can exfiltrate
your like information back out, right?
Um,
that's like they still need to be able
to extract information. And so, if you
sandbox the network, that's a good way
of doing it.
Um, if you're hosting on a sandbox
container like Cloudflare
um, Modal or, you know, AWS or
DigitalOcean, like all of these like
sand- sandbox providers, they've also
done like some level level of security
there, right? So, like you're not
hosting it on your personal computer um,
or on a computer with like your broad
secrets or something. So,
uh, yeah, lots of different layers
there. And And yeah, we can talk more
about hosting in depth. Um, so,
okay. So, I'm going to
uh, talk
a little bit about bash and all you
need, you know? Um, I think this is
something that Oh, yeah. Um,
this is like my stick, you know? I am
I'm just going to like keep talking
about this until everyone like
uh, agrees with me.
Um, or like I I think this is something
that we found at Anthropic. I think it
is sort of something I discovered once I
got here.
Um, bash is what makes Claude Code so
good, right? So, I think like you guys
have probably seen like code mode or
programmatic tool use, right? Like the
um, different ways of like composing
APIs.
Uh, Cloudflare's put out some blog posts
on that. We've put out some blog posts.
Uh, the way I think about code mode is
like or bash is that it was like the
first code mode, right? So, the bash
tool allows you to, you know, like store
the results of your tool calls to files,
uh, store memory, dynamically generate
scripts and call them, compose
functionality like tail, grep. Uh, it
lets you use existing software like
FFmpeg or LibreOffice, right? So,
there's a lot of like interesting things
and powerful things that the bash tool
can do. And like, think about like
again, what made Claude Code so good. If
you were designing an agent harness,
maybe what you would do is you'd have a
search tool and a lint tool and execute
tool, right? And like, you know,
n tools, right? Like every time you
thought of like a new use case, you're
like, "Oh, I need to have another tool
now, right?"
Um, instead, now Claude just uses grep,
right? Or it knows your package manager,
so it runs like npm run like
test.ts or index.ts or whatever, right?
Like it can lint, right? And it can find
out how you lint, right? And it can run
npm run lint. If If you don't have a
linter, it can be like, "What if I
install ESLint for you?" right? So,
um,
this is like, you know, like I said, the
first programmatic tool calling, first
code mode, right? Like you can
do a lot of different actions very very
generically, right? Um,
and so, to talk about this a little bit
in the context of non-coding agents,
right? So, let's say that we have
an email agent and the user is like,
"Okay, how much did I spend on ride
sharing this week?" Um,
and, you know, like it's got one tool
call or generally it's got the ability
to search your inbox, right? And so, it
can run a query like, "Hey, search Uber
or Lyft," right? And
without bash, it it searches Uber or
Lyft, it gets like 100 emails or
something, and now it's just got to like
think about it, you know what I mean?
And I I think like a good like analogy
is sort of like imagine if someone came
to you with like
like a stack of papers and like, "Hey,
how much did I spend on ride sharing
this week? Can you like read through my
emails?" You know what I mean? Like that
that would be really hard, right? Like
you need a very very good precision and
recall to do it. Um,
or with bash, right? Like
let's say there's a Gmail search script,
right? It takes in a query function,
um, and then you can start to save that
query function to a file or pipe it. You
can grep for prices, you know, you can
uh, then add them together. You can
check your work, too, right? Like you
can say, "Okay, let me grep all my
prices, store those as like in a file
with line numbers, and then let me then
be able to check afterwards like,
uh, was this actually a price? Like what
does each one correlate to, right?" So,
there's a lot more like dynamic
information you can do to check your
work with the bash tool. So, this is
like
um, just a simple example, but like
hopefully showing you sort of the power
of like the composability of bash,
right? So, uh, I'll pause there. Any
questions on bash is all you need, the
bash tool, any any thing I can make a
little bit clearer?
Do you have stats on how many people use
YOLO mode? I think it's like
Uh, stats on YOLO mode. We probably do.
Um, I mean, internally we we don't, uh,
but that's just I think we just have a
higher security posture. Um,
>> [clears throat]
>> yeah, I'm not sure. Uh, I can probably
pull that.
Any other questions on bash?
Okay, cool. Um,
yeah, just to give you like some more
examples, like let's say that you had an
email API and you wanted to
uh, you know, like go through like fetch
my like tell me who emailed me this
week, right? So, you've got two APIs.
You've got an inbox API and a contact
API.
This is like a way you can do it via
bash. You can also do it via code gen.
This is kind of like enough bash that it
It is code gen, right? Like
bash is a
ostensibly code gen tool. Um and then,
yeah, like let's say that you wanted to
You had a video meeting agent, right?
You want to say like, "Find all the
moments where the speaker says quarterly
results in this earnings call." Right?
You use FFmpeg to like slice up this
video, right?
You can use JQ to like start analyzing
the information afterwards. So,
yeah, lots of like def like powerful
ways to use
to use bash. So,
I'm going to talk a little bit about
workflows and agents. They can do both.
You can use build workflows and agents
on the agent SDK. Um yeah, agents are
like cloud codes. So, if if you are like
building something where you want to
talk to it in natural language and take
action flexibly, right? Then that's
where you're building an agent, right?
Like you want You have an agent that
talks to your like business data and you
want to get insights or dashboards or
answer questions or write code or
something. Like that's an agent, right?
And then a workflow is kind of like, you
know, we do a lot of GitHub actions, for
example, right? So, you define the
inputs and outputs very closely, right?
So, you're like, "Okay, take in a PR and
give me a code review."
And yeah, both of these you can use
agent SDK for. Um when building you can
use structured outputs.
We just released this.
You can yeah, Google agent SDK
structured outputs. Um
But yeah, so you can do both. I'm going
to primarily be talking about agents
right now. A lot of the things that you
can like learn from this are applicable
to workflows as well. So,
yeah, it will will talk about this.
Uh wait,
show of hands. How many people have like
designed an agent loop before?
Okay, cool. Okay, great. Great.
So, yeah, I mean, I think the number one
thing that the meta learning for
designing an agent loop to me is just to
read the transcripts over and over
again. Like every time you see see the
agent run, just read it and figure out
like, "Hey, what is it doing? Why is it
doing this? Can I
help it out somehow?" Right?
And we'll do some of that later, right?
So, we'll
we'll build an agent loop.
Um
But here is the
the three parts to an agent loop, right?
So,
first, it's gather context, right?
Second is taking action, and the third
is verifying the work, right? And
uh this is like not the only way to
build an agent, but I think a pretty
good way to think about it.
Gathering context is
like, you know, for cloud code, it's
grepping and finding the files needed,
right?
You know, for an email agent, it's like
finding the relevant emails, right?
And so, these are all like pretty
Yeah, like I I think thinking about how
it finds this context is very important,
and I think a lot of people sort of
uh skip this step or like underthink it.
This can be like very very important.
And then taking action,
how does it like do its work?
Does it have the right tools to do it?
Like code generation, bash, these are
more flexible ways of taking action,
right? And then verification is another
really important step. And so, the
Basically, what I'd say right now is
like, if you're thinking of building an
agent, think about like can you verify
its work, right? And if you can verify
its work, it's like a great like
candidate for an agent. If you can't
verify its work, like it's like, you
know, coding you can verify by linting,
right? And you can at least make sure it
compiles. So, that's great. If you're
doing, let's say, deep research, for
example, it's actually a lot harder to
verify your work. One way you can do it
is by citing sources, right? So, that's
like a step in verification. But
obviously, research is less verifiable
than code in some ways, right? Because
like code has a compile step, right? You
can also like execute it and see what it
does, right? So,
I think like thinking on you know, like
as we build agents, the ones that are
closest to being very general are the
ones with the verification step that is
very strong, right? So,
I think there was a question here. Yeah.
>> So,
when
where do you generate the plan of the
work you need to do?
Mm.
Yeah, I mean, you you might
>> question. Oh, yeah, sorry. The The
question was when do you generate a plan
before you run through it? So,
um
like in cloud code, you don't always
generate a plan, but if you want to,
you'd insert it between the gathering
context and taking action step, right?
And so,
plans sort of help agent think through
step by step, but they add some latency,
right? And so, there is like some
trade-off there.
But yeah, the agent SDK helps you like
do some planning as well. So, yeah.
Yep. Can you like make the agent create
that to-do list
or like 100%
sure that it will
create that to-do list and run by it? Uh
yeah, so the question was will the agent
create the to-do list?
Uh
yes.
If you're using the agent SDK, we have
like some to-do tools that come with it,
and so it will like maintain and check
off to-dos that you can display them as
you go. So, yeah.
Um
any other questions about this right
now?
Okay, cool. Okay, so I'm going to
quickly talk about like like how do you
do this stuff? You Like what are your
tools for doing it, right? And uh there
are three things you can do. There you
have tools, bash, and code generation,
right? And I I think traditionally, I
think a lot of people are only thinking
about tools. And
yeah, basically, one of the call to
actions is just figuring out like
thinking about it more broadly, right?
So, tools are extremely structured and
very very reliable, right? Like if you
want to sort of have as fast an output
as possible with minimal errors, minimal
retries,
tools are great. Uh cons, they're high
context usage. If anyone's built an
agent with like 50 or 100 tools, right?
Like they take up a lot of context and
the model it kind of gets a little bit
confused, right? There's no like sort of
discoverability of the tools,
and they're not composable, right? And
And I say tools in the sense of like if
you're using, you know, a messages or
completion API right now,
that's how the tools work. Of course,
like, you know, there's like code mode
and programmatic tool calling, so you
can sort of blend some of these. Um then
there's [clears throat] bash. So, bash
is very composable, right? Like static
scripts, low context usage. It can take
a little bit more discovery time. Like
cuz like let's say that you have
whatever, you have like the Playwright
MCP or something like that.
Sorry, the Playwright CLI, the
Playwright like bash tool.
You can do playwright help to figure out
all the things you can do, but the agent
needs to do that every time, right? So,
it needs to like discover what it can
do,
which is kind of powerful that it helps
take away some of the high context
usage, but adds some latency.
There might be slightly lower call
rates, you know, just because like it
has a little bit more time to um
it needs to like find the tools and and
what it can do.
But this will definitely like improve as
it goes. And then finally, code gen.
Highly composable, dynamic scripts.
Um
They are take the longest to execute,
right? So, they need linting, possibly
compilation. API design becomes like a
very very interesting step here, right?
And I And I'll talk more about like
best like how to think about API design
in an agent. Um But yeah, I I think this
is like how you like the the three tools
you have. And so, yeah, using tools,
think You still want some tools, but you
want to think about them as atomic
actions your agent usually needs to
execute in sequence, and you need a lot
of control over, right? So, for example,
in cloud code, we don't use bash to
write a file. We have a write file tool,
right? Because we want the user to be
able to sort of see the output and
approve it, and um we're not really
composing write file with other things,
right? It's like a very atomic action.
Sending an email is another example.
Like any sort of like non-destructive
like destructible or sort of like, you
know,
un reversible change is definitely like
a tool is a good place for that.
Then [clears throat] you got bash. So,
for example, there are like
uh composable actions like searching a
folder, using GitHub, linting code and
checking for errors or memory.
And so, yeah, you can write files to
memory, and that can be your bash like
bash can be your memory system, for
example, right? So,
and then finally, you've got code
generation, right? So, if you're trying
to do this like highly dynamic, very
flexible logic, composing APIs,
like you're doing data analysis or deep
research or like reusing patterns. And
so,
yeah, we'll talk more about
code generation in a bit.
Um any questions so far about like
the SDK loop or tools versus bash versus
code gen?
Yeah. Yeah, I was going to ask
>> [clears throat]
>> how about are you going to have any
ready-made tools for like uploading tool
call results? [snorts]
Uploading tool call results like into
the file system or
>> Like let's say it goes to bash, and then
context explodes. Mm. Is it like
[clears throat] type the command that
like do everything now? Okay. Or or
otherwise, just like long outputs will
be in your history. Sure, yeah. Yeah.
Yeah. I don't imagine like all the time
just uploading them files. Yeah. Yeah. I
I think that's a good common practice. I
think
we
I I remember seeing some PRs about this
very recently on on Claude Code about
handling very long outputs. And
I
I I don't
know exactly. Like I I think I think we
are moving towards a place where more
and more things are being like just
stored in the file system. And this is
like a good example. Yeah, like it's
storing like long outputs
over time.
I think like generally prompting agent
to do this is a good
way to think about it. Or even if you
have I think like something I just do
always now is like whenever I have a
tool call, I
I save it like the results of the tool
call to the file system so that you can
like search across it and then have the
tool call return the path of the result.
Just because like that helps it like
sort of recheck and its work. So
um
Yes. Um do you find that you need to
use [clears throat] like the skills
construction to
help Claude along to use the bash better
or out of the box you know that's not
necessary. Yeah, so the question was
about skills and like do we need skills
to use bash better?
Um yeah, for context skills
Skills. Okay, yeah. Skills are
basically a way of like
you know allowing our agent to take
longer complex task and like sort of
load in things via context, right? So so
like for example, we have a bunch of
docx skills. And these docx skills tell
it how to do code generation to generate
these files, right? And so
yeah, I think overall skills are yeah,
basically just a collection of files.
They're also sort of like an example of
being very like file system or bash tool
built, right?
Because they're just really just folders
that your agent can like CD into and
like read, right?
And so yeah, they give like what we
found the skills are really good for is
pretty like repeatable instructions that
need a lot of expertise in them.
Like for example, we released our front
end design skill recently that I really
really like. And
it's really just sort of very detailed
and good prompt on how to do front end
design. But it comes from like our best
you know like
AI front end engineer, you know what I
mean? And he like really put a lot of
top thought and iteration to it. So
that's one way of using skills.
Um
Yeah.
Quick question. Yes.
So the question was about skill.md
versus claude.md and how to think about
that, right? And
I think like I I'll say all of these
concepts are so new. You know what I
mean? Even Claude Code is like released
it like eight or nine months ago, right?
Like
and so skills were released like two
weeks ago. Like I like I won't pretend
to know all of the best practices for
for everything, right?
I think generally
skills are a form of progressive context
disclosure. And that's sort of a pattern
that we've talked about a bunch, right?
Like with like bash and you know like
preferring that over like you know
purely like normal tool calls. It's like
it's a way of like the agent being like,
"Okay, I need to do this. Let me find
out how to do this." and then let me
read in the skill.md, right? So you ask
it to make a docx file and then it like
CDs into the directory, reads how to do
it, writes some scripts and keeps going.
So
Yeah, I think like there's still some
intuition to build around like what what
exactly you like define as a skill and
how you split it out.
But
yeah, I think uh
Yeah, lots of best practices to learn
there still.
Yeah.
So yesterday
talked [clears throat] about the future
of skills. Okay.
Do you see these as ultimately becoming
part of the model or
are some of the skills just a way to
bridge the gap
Yeah, so the question was are skills
ultimately part of the model?
Are they a way to bridge the gap? I
missed Barry's talk and Barry mentioned
talk yesterday, but yeah, I think
roughly the idea is that the model will
again better and better at doing a wide
variety of task and skills are the best
way to give it out of distribution task,
right?
But [clears throat]
I I would broadly say that like it's
really really hard especially like you
know if you were
like
not at a lab to like tell where the
models are going exactly.
My general
rule of thumb is like I try and like
rethink or rewrite my like agent code
like every six months
just cuz I'm like things have probably
changed it enough that I've like baked
in some assumptions here. And so
like I think that like our agent SDK is
built to as much as possible sort of
advance with capabilities, right? Like
the bash tool will get better and
better.
We're building it on top of Claude Code.
So as Claude Code evolves, you'll get
those wins out of the gate.
But at the same time like you know
things are so different now like than
they were a year ago in in terms of like
AI engineering, right? And I think like
a general best practice to me is sort of
like, "Hey, we can write code 10 times
faster. You should throw out code 10
times faster as well."
And I think thinking about like not so
like hedging your bets on like where is
the future right now, but like what can
we do today that really works, right?
And like like let's get market share
today and not be afraid to throw out
code later.
If you're a startup, this is arguably
your largest advantage that you have
over competitors. They're like you know
larger
>> [snorts]
>> companies have like six-month incubation
cycles. And so they're always like stuck
in the past of like with the agent
capabilities, right? And so your
advantage is that you can like be like,
"Hey, the agent the capabilities are
here right now. Let me build something
that uses this right now." Right? So
um
Yeah.
Uh
Any any other questions on for We're
talking about skills and bash. Okay, it
seems like there are a lot of skill
questions. So
um
Yeah,
I think
at the back someone you might have to
shout. Yeah, so why would you use a
skill versus an API? They look very
similar to
that Python program there could be a
package, right? Yeah, so the question
was why use a skill versus an API?
Good question. I I think that like
um
when you like these are all forms of
progressive disclosure basically to the
agent to figure out what it needs to do.
And I'll go over like examples of like
you just have an API, right? In in our
like in our prototyping session.
It's totally like use case dependent,
right? Like just I think like I don't
have a like I don't think there's a
general rule. I think it's like read the
transcript and see what your agent
wants. If your agent always wants
like thinks about the API better as like
a API.ts file or something or API.py
file, do that. You know, that's a great.
Like I think skills are like a like sort
of an introduction into like thinking
about the file system as a way of
storing context, right? And they're a
great abstraction.
But there are many ways to use the file
system.
Um
And I I should say that like something
about skills is that like you need the
bash tool, you need a virtual file
system, things like that. So the agent
SDK is like basically the only way to
really use skills to like their full
extent right now. So
um
Yeah. Yeah, back there.
Yeah, the question was can we expect a
marketplace for skills? So
yeah, Claude Code has a plugin
marketplace that you can also use with
the agent SDK.
We're evolving that over time. You know,
like it was like a very much a V0.
And by marketplace, I'm not sure if
people will be charging for this
exactly. It's more just like a discovery
system, I think. But yeah, that exists
right now. You can do {slash} plugins in
Claude Code
and you and you can find some. So
Yeah. What's your current thinking about
when you're going to reach for like the
SDK you know to solve a problem?
When Yeah, so the question is when do I
use the SDK to solve a problem?
If I'm building an agent basically, I I
think that like My overall belief is
that
like for any agent, the bash tool gives
you so much power and flexibility and
using the file system gives you so much
power and flexibility that you can
always eke out performance gains over
it, right? And so
yeah, in the prototyping part of this
talk, we're going to like look at an
example with only tools and example
without with you know, bash and the file
system and compare those two.
And yeah, that's what I mean by that
being bash tool built. I'm like I I just
like start from the agent SDK, you know?
And I think a lot of people at Anthropic
have started like doing that as well. So
of course I I do want to say that there
are lots of times where the agent SDK is
kind of annoying cuz you've got like
this network sandbox container and
you're like, "I hate like I don't want
to do this." You know what I mean? Like
I want to run on my browser locally,
right?
I totally get that. I think it's there
is like a real performance trade-off.
The way I think about it is sort of like
React versus like jQuery. You know, like
I like I when I was coming up, I was
like very into web dev and like, you
know, I was using jQuery and backbone
and then React came out and it was by
Facebook and they're like, you have to
Here's JSX, like we just made this up
and and now there's a bundler, right?
I'm like, it's so annoying. Um, but like
they generally makes the model or it
makes it made web apps more powerful,
right? And I think we're sort of like
the agent SDKs are like the React of
agent frameworks to me because it's like
we build our own stuff on top of it, so
you know it's real and all the annoying
parts of it are just like things where
we're annoyed about it, too, but we're
like it just it just works, like you
have like got to do this, you know? Um,
so yeah.
Uh, yeah, okay, more more skill
questions, I guess. Yeah, right here.
Uh, I want to talk about the style of
the
>> Bash question, great. I love bash. Yeah,
custom internal like bash tools.
>> Yeah. How do you even discover that or
do you have to become fluent in tools?
Okay, the question is if you have custom
agent bash tools, how do you let the
agent discover that? By custom bash
tools, do you mean like bash scripts or
>> have yeah, bash scripts, yeah. Yeah.
Um, yeah, so I I think uh, where is it?
You just put it in the file system and
you tell it like, hey, like here is a
script. Uh, you can call it, you know, I
I mean generally thinking in the context
of the cloud agent SDK where it has the
file system and the bash tools are tied
together. This is kind of an
anti-pattern I see sometimes where
people are like, oh, like we're going to
host the bash tool in this like
virtualized place and it's going to not
going to interact with other parts of
like the agent loop, you know? And that
sort of, you know, makes it hard cuz if
if you got a tool result that's saving a
file, then your bash tool can't like uh,
read it, you know, I mean, unless it's
all in one one container, so but does
that answer your question?
Like Yeah, kind of. I mean, like
So you're just saying you just put it in
like a system prompt or something? Yeah,
just put in system prompt and be like,
hey, you have access to this. Uh, I
would like sort of design all my CLI
scripts to have like a dash dash help or
something, so that the model can call
that and then it can like progressively
disclose like every like sub command
inside of the script, yeah.
Uh, yeah, like there. Yeah. So, uh, like
my question is on when to reach for the
agent SDK. So, have you designed or
rather would you recommend someone use
the agent SDK to build like a generic
chat agent? Ask him there to like, oh,
you know, I'm building an agent where
you have some input and the agent goes
and does some stuff and finally I care
about the output. Ask him back to let's
say someone, like are you using or do
you foresee using the agent to build
like the agent SDK to build like Claude,
the the app, rather than Claude code?
Uh, yeah, so the question is when do we
reach for the agent SDK?
Uh, does
um,
like
like would we use the agent SDK to build
Claude.ai, which is the more traditional
chatbot, uh, than Claude code?
Um,
I one, I think Claude code is like a
very like like interface is not a
traditional chatbot interface, but like
the inputs and outputs are far, right?
Like you input code in, you you get like
or you input text in, you get text out
and you you take the actions along the
way. Um,
you might have seen that like when we
rolled out doc creation for Claude.ai,
um,
now it has the ability to spin up a file
system and like create spreadsheets and
PowerPoint files and things like that by
generating code. And so that is like,
you know, we're in the midst of sort of
like
um, like merging our agent loops and
stuff like that, but but broadly like
you uh,
like yeah, Claude.ai will like is
getting more and more like you see it
with skills and the memory tool and
stuff, more and more file system built,
right? So, uh, we do think it's like a
broad thing that you can use just just
generally and it have been talked
through like
Um, yeah, one more question and then
we'll move it on, yeah. Uh, still trying
to understand the rule of thumb on when
to build a tool or use a tool, when to
wrap something with a script or just let
the agent
go wild on the bash. Cuz I'll I'll give
you an example.
Let's say I need to access a database
from time to time. I can use an SCP, I
can wrap it in a script and I can just
let the
agent call an endpoint from that
directly from bash, right?
Yeah, great question, great question.
So,
still trying to grok like when to use
tools versus bash versus code gen and he
gave an example like, okay, I have a
database. Um, I want the agent to be
able to access it in some way, what
should I do? Should I create a tool that
queries the database in some way? Um,
should I use the bash? Should I use code
gen, right? These are all these are
three ways of doing it. Um, I think that
they are like you could use any of them
and I I think like part of it is like I
I think
Unfortunately, there's no like single
best practice, right? This is like kind
of a system design problem. But let's
say that you want to access your bash
your database via tool, you would do
that if your database was very, very
structured and you have to be very
careful about like
I don't know, you're accessing like user
sensitive information or something like
that and you're like, hey, I I can only
take in this input and I need to like
give this output and I have to mask
everything else about the database from
the agent, right? Obviously, that like
sort of limits what the agent can do,
right? Like it can't write a very
dynamic query, right? Um, if you're
writing a full on SQL query, I would
definitely use bash or code gen, uh,
just because when the model is writing a
SQL query, it can make mistakes and the
way it fixes it is is its mistakes is by
like linting or like running the file,
looking at the output, seeing if there
are errors and then iterating on it,
right? Um, and so I generally like if
I'm building an agent today, I'm giving
it as much access to my database as
possible and then I'm like putting in
guardrails, right? Like I'm probably
limiting its like write access in
different ways, but what I probably what
I would do is like I would give it
write access and put in specific rules
and then give it feedback if it tries to
do something it can't do, you know what
I mean? And so I know this is like kind
of a hard problem, but I think this is
the like
set of problems for us to solve, right?
Like we built a bash tool parser,
um,
and that's a super annoying problem, uh,
but we need to solve that in order to
like let the agent work generally,
right? And same thing with like database
like like yes, it's quite hard to
understand what is the query doing, but
if you can solve that, you can let your
agent work more generally over time. So,
um, yeah, I I think thinking about it
uh, like flexibly as much as possible
and keeping tools to be like very, very
like sort of atomic actions, right? That
you need a lot of guarantees around.
Um,
Yeah, one more question. Uh, the same
thing, like
how do you ensure that role-based access
controls are taken care of?
How do you
uh, so the question is how do you ensure
that the role-based
access controls are taken care of?
Usually, that's in like how you
provision your API key or your back end
service or something like that, right?
Like
I think that like probably what I do is
like they create like temporary API
keys. Sometimes people create proxies in
between to insert the API keys,
um, if you're concerned about
exfiltration of that. Uh, but yeah, I
would create like API keys for your
agents that are scoped in certain ways
and so then on the back end, you can
sort of check it's like, you know, what
it's trying to do and like uh, if it's a
an agent, you can like give it different
feedback, so yeah.
All right, yeah, one question. Um,
anything you can tell us uh,
more about the the memory tool, the
internal memory tool?
Um,
I have I I'm not trying to like keep a
secret. I I don't know exactly, like I
haven't read the code, but I I think it
generally works on on the file system.
And so Is it exposed to to the
agent SDK or is it already built in?
Um, I would say that like we we've had
this question a bunch. I would just use
the file system in the cloud agent SDK.
I would just create like a memories
folder or something and tell it to write
memories there.
Um,
it's like
I I don't know the exact implementation
of the memory tool, but it does use the
file system in in in that way, so yeah.
Um, all right, yeah, yeah, last question
on this, yeah.
How you manage for the bash and the
code, how you are managing the like
reusability? Suppose the same agent is
rolled out to hundreds of users and same
code every time it is generating and
every time it is executing, so how can
we use the reusability?
Yeah, that's a really good question. So,
uh,
yeah, let's say you have two agents
interacting with two
different people. The question is like,
how do you think about reusability
between agents or how do agents
communicate, right?
Um, I think uh, this is a thing to be
discovered, I think. Like I think
there's a lot of best practices and
system design to be done on like
um, because traditionally with web apps,
you're serving one app to like a million
people, right? And with agents, like
with Claude code, we serve like, you
know, a one-to-one like container. When
you use Claude code on the web, it it's
like it's your container, right? And so
there's not a lot of like communication
between containers. It's a very, very
different paradigm. I'm not going to say
that like I know exactly the best system
design to do that, right? And like I
think there's a lot of best practices on
like, okay, these agents are reusing
work,
how can we give them like like like
general scripts that combine together
the work that they've done, how can we
make them share it? Um I would generally
think this is sort of like a tangent but
on like
agent communication frameworks. I would
say that like we probably don't need
like a whole we don't I I think this
more of a personal opinion. I think like
if we probably don't need to reinvent uh
like a new communication system. They're
like the agents are good at using the
things that we have like HTTP requests
and hash tools and API keys and uh named
pipes and all of these things and so
like probably like the agents are just
making HTTP requests back and forth from
each other, you know, using HTTP server.
Um
there's a bunch of interesting work
there. I've seen people make like a
virtual forum for their agents to
communicate and they like post topics
and we like reply and stuff like that.
Um kind of cool. I think there's a lot
of things to explore and and discover
there. Yeah.
Okay. Um
going to keep going a little bit. How
are we doing for time? Okay, it's got an
hour left I think. Okay. Um
Cool. So an example of designing an
agent.
Uh this is a like yeah, let's this is
not the prototyping session but I think
this is a like will be a good sort of
like like we will wait into it. Let's
say we're making a spreadsheet agent. Uh
what is the best way to search a
spreadsheet? What's the best way to
execute code and like what's the best
way to take action in a spreadsheet?
What is the best way to link a
spreadsheet, right? These are all like
really interesting things to do. Uh I'm
going to do like a Figma we can go over
it. Um
If someone could grab a water as well,
that would be great. I like could really
use water right now. Yeah.
Yeah. Okay.
Um
thanks.
Okay, so we're going to
Yeah, let let's let's talk through it.
Uh or want to you spend like a couple
minutes yourselves thinking about this
question. You have a spreadsheet agent.
You want it to be able to search you
want to be able to like gather context,
take action, verify its work. How would
you think about it, right? So like just
spend some time thinking through that,
take some notes or something.
Okay, is everyone
had a little bit of time to think about
this? Did anyone want more time or want
to just dive into it?
Okay.
Uh what's the best way for an agent to
search a spreadsheet? One thing I have
to type with one hand down.
Um
I should figure this out cuz I'm going
to be typing later. Okay. Um
the Okay, searching a spreadsheet.
Any any ideas? How do you search a
spreadsheet? Like what would you do?
CSV.
Okay, you've got a CSV. Okay, now like
your agent wants to like search the CSV.
What what does it do?
It grabs it. Okay.
Uh what does the grep look like? You
just look at all the headers. Looks at
the headers. Okay.
>> Headers of all
sheets. Okay, great. Yeah, yeah. And
let's say I'm looking for the revenue in
2024 or something. Um
Now I've got my headers like uh I'm I'm
just going to pull up a spreadsheet,
right? Um let's say that the revenue is
in there's a revenue column and then
there's like a
uh say let's see.
Okay, so yeah, let's say it's something
like this, right? Like
um how do I get revenue in 2026, right?
So this is sort of like a tabular
problem, right? Like there is revenue
here and there's also 2026 here, right?
So it's like a multi-dimensional stuff,
right? We could look at the headers that
will then give us
uh like if you just pull this, you'll
get 100 200 300, right? So we need a
little bit more and
uh any other ideas?
Yeah. There's a bash tool for it, the
awk a w k I think. Awk? Okay. Yeah,
yeah, yeah. And what would it awk for?
Well, it depends on what you what you're
looking for.
>> Yeah, yeah, yeah. That's the That's the
question, right? Like what what is the
user looking for, right? They're
probably looking for something like this
like revenue in 2026, right? Um Maybe
use the APIs to use the Google tools to
add all the numbers together or VLOOKUP
something like this.
Yeah, so idea is like use the APIs like
use the Google APIs to like look it up.
Um that's great. But yeah, let's say
we're working locally. We need to sort
of design these APIs, yeah? SQLite.db
Interprets CSV directly. It works as
well.
Oh, interesting. Okay, yeah, I didn't
know that. That's great. So yeah, you
you use SQLite to query a CSV. Um that's
a great like sort of creative way of
thinking about API interfaces, right?
Like um if you can translate something
into a interface that the agent knows
very well, that's great, right? And so
like if you have a data source, if you
can convert it into a SQL query, then
your agent really knows how to search
SQL, right? So thinking about this
transformation stuff is really really
interesting. It's a great way of like
designing like an agentic search
interface. So
um yeah, brother. Just real quick. We're
talking about tools cuz you can use CSV
for some of this stuff as well. Yeah. Is
there any ranking within the tool with
this Claude smart enough to start
ranking the right tool for the right
job? Cuz that's kind of what we're
talking about here. It's right tool for
the right job. Yeah, is Claude smart
enough to write rank the right tool for
the tool for the right job? Uh yeah, if
you prompt it, you know, like or like I
I think this is one of those things
where like I don't know, let's find out.
Like let's read the transcript. Uh if
it's not, like how can you help it?
Yeah, just sort of like I I think all of
these things are like an intuition, you
know, it's like like kind of like riding
a horse. Not that I've ever rode a horse
but I don't know I just like
I can imagine it's like riding
>> [laughter]
>> Yeah, like you you you you like you
know, you're sort of giving these
signals to the horse, you're calming it
down, you're trying to find what it how
how do you push it faster, you know,
what I mean? And sort of like it's a
very organic like thing, right? Um like
I think we like to say that models are
grown and not designed, right? And so
we're like sort of understanding their
capabilities, yeah.
Uh yeah, what and where it is, yeah.
Quick question. So is there a way to add
metadata to the spreadsheet? Can you
give descriptions in different
documents? Mm yeah, that's For example,
KPIs. I'm trying to get an idea of how
to build intelligent response questions
for spreadsheets. Yeah, so that's
another great pattern is like okay, can
you add metadata to a spreadsheet? So
these are some questions that you might
want to think about before
like when you're thinking about search
is like what preprocessing can you do to
make the search better, right? And so
one example is that you could translate
it into like a SQL format or something
where you do something that can query
it, right? That's like a translation
step. Another step is like maybe you
have a tool or
like a a preprocessing step where
another agent annotates the the
spreadsheet and and like adds
information so that the agent can then
like search across that information
better, right? So
Yeah, one more. Um I was just curious
>> Oh, yeah.
what I mean all those tools sound great
but why can't the agent just, you know,
do what was suggested, read the header
and then just get the data, like I feel
like that should just be pretty trivial
to do.
Um
or or read task. Yeah, probably I should
have like prepared this in code, didn't
I?
But yeah, I I built a ton of spreadsheet
agents before. Basically it's It's not
work. It It's kind of hard to do. Yeah,
yeah. So um basically what I what I
would think about is like so we we got
like Okay, I
Sean, do you have a suggestion on how I
can how I can
code at the same time, right? Install
voice to text on your Oh, I see. Yeah,
yeah, yeah.
Do you work at Whisper Flow or something
or
Stick the mic in your shirt. There's a
microphone button on the back.
>> [laughter]
>> There's a microphone button on the back.
Stick the mic in your shirt.
Oh,
I I just don't trust that stuff, man.
Okay. Um
>> [laughter]
>> Maybe I shouldn't
Maybe I shouldn't be working in an AI
lab, man.
Um
Okay, so
uh let's see.
Hold on. Hold on. Okay. Um
like that's search. So
one way to do it is like
you see in spreadsheets, right? Like you
can say here you can design formulas,
right? So like B3
to
All right.
So, this is the syntax for example that
the agent's pretty familiar with, right?
B3 to B5, right? And so, you can design
an agentic search interface which is
like this, right? Like B3
B5 or something, right? So, like your
agentic search interface can take in a
range, right? You can take it take in a
range string, right? And these are
things that like the uh knows pretty
well, right? Like you can
um
do SQL queries, right? The agent knows
SQL queries pretty well, right? Um
and
uh like these you can also uh
do XML, right? Sorry, the font is so
small.
Um
Okay.
Uh Yeah, you can also do XML. I I
I'm not sure if you guys know, but like
uh actual X files are XML in the back
end, right? And XML is very structured.
Uh you can do like an XML search query
uh and there are different libraries
that can do that. So, that's one
example, right? It's like how do you
search and gather context? And I hope
this sort of like illustrates to you
that like gathering context is really
really creative, right? Like and and
like there's so many iterations and if
you've just if you've only tried one
iteration, it's probably not enough,
right? Like think about like as many
different ways as you can. Like try
these out, right? Like try SQL or try
try the search try try the grep and awk
and like all of these things and um
have a few tests that you're trying
across different things and and see what
the agent likes and what it what it
doesn't like. Um it's going to be
different for each case. Sorry. Yeah.
You mean you When you say agent, you're
referring to
the bot the the model or
Cuz we're loading an agent here. Yeah.
And you're relying on already
pre-existing knowledge of how to handle
XML. Who's Who's doing that? The model?
Yeah, cuz the question is like who what
Where does the knowledge come from? Is
it the model? Is it like what do what do
I mean by the agent? Yeah, generally
what I think what you're looking for is
like you have a problem, you want to
make it as in-distribution as possible
for the agent, right? And so, the agent
knows a lot about a lot of different
things. It knows a lot about for example
finance, right? So, if you ask it to
make a DCF model, it knows what DCF is,
right? And you can if if you want to
give it more information, you can make a
skill, right? But so, it it knows what
DCF is, it knows what SQL is. Can it
combine those things together, right?
And so, like uh ideally, you want to
like your your problem is going to be
out of distribution in some way, right?
Like like there's some like information
that's not on the internet or something
that you have um or something somewhat
unique to you and you want to try and
like massage it to be as in-distribution
as possible.
Um and uh yeah, it's it's very very
creative, I think. Like uh you know,
it's not like a
it's not a science to me. It's
>> [laughter]
>> very much like an art. So. Um
Yeah, okay. So, we we've tried gathering
context, then taking action.
Um we can probably do a lot of the same
stuff here that we've done before,
right? Like we can do like
insert
to the array, right?
Um
if you've got like a SQL interface,
right? We can
um
we can do a SQL query. We can edit XML.
Um
These are like often very similar,
right? Like taking action and gathering
context. You probably want a similar API
back and forth. And then the last thing
is verifying work, right? Like how do
you think about how do you think about
that? Um
check
for null pointers,
right? Is one of the ways to do it.
Um
any other ideas on on verification or
Yeah? Sorry, I'm I'm a bit confused
about what you're saying.
>> Yeah, yeah.
Like when when you're using other SDKs
to build the agent, I don't need to tell
it how to gather the context. Sure. I
just give it the context and explain
this is what's like basically I explain
in plain English what it's meant to do.
Yeah.
And
what I tend to do, and you tell me if
I'm wrong, I actually end up creating a
separate agent for QA Oh, interesting.
to to verify because I don't trust the
agent to verify itself. Mhm.
But I'm just I'm I'm just a bit I I'm
being confused about the level of detail
I need to provide the agent in that
example.
Yeah, okay. So, the question is about um
giving context to the agent versus
having it gather its own context. Uh you
mentioned that you sometimes use a Q&A
agent. Uh can I ask like what like
domain you you're building your agent in
or In
uh cybersecurity. Okay, sure. Yeah,
yeah. Um
I think that
I I think I need to like look into more
specifics, but the Cloud Agent SDK is
great for cybersecurity and like I would
generally push people on like let the
agent gather context as much as
possible. You know, like let it find its
own work as much as possible.
Um
you're trying to give it the tools to
find its own work. The way I think about
this is kind of like let's say that
someone locked you in a room and they
were they were like giving you task, you
know, like so that's what your what your
job was. Like a Mr. Beast sort of like
scenario, right? Like you get $500,000
to stay in this room for 6 months. Um
then like like someone's giving you a
message, what tools would you want to be
able to do it, right? Like would you
just want like a list of papers or like
would you want a calculator or like a
computer, right? I probably I would want
a computer, right? I'd want Google, I'd
want like all of these things, right?
And so, like I wouldn't want the person
to send me like a stack of papers being
like, "Hey, this is probably all the
information you need." I'd rather just
be like, "Hey, just give me a computer,
give me the problem, let me search it
and figure it out, right?" And so,
that's how I think about agents as well.
Like they need like
like you know, they're stuck in a room.
>> So, you have to give them tools. So, if
you can go back to the slides you have
to the
graphs you have?
To the graphs like like this you mean or
Yeah, this top one. So, basically that
gathering context is basically these are
the tools that I'm offering it.
Yeah, exactly. Yeah, you you're I'm
giving it like maybe an API for code
generation, maybe I'm giving it a SQL
tool, maybe I'm giving it a bash. These
are all like examples, right? So, yeah.
You have one question? Question. So, uh
for all the agents that you're
>> [clears throat]
>> having in a certain state, do they share
the same context window
and what's the size of it?
Interesting. Yeah, so do agents share
the context window? I think I think this
is like an interesting question is
overall about how you manage context. Uh
I think and I haven't talked about this
too much, but sub agents are like a very
very important way of managing context.
Um
I think that this is like we're using
more and more sub agents inside of Cloud
Code and I would think about like doing
sub agents very generally. So, like what
we might do for this spreadsheet agent
is maybe we have a search sub agent,
right? So, like sub agents are great for
when you need to do a lot of work and
return an answer to the main agent. So,
for search, let's say the question is
like how do I find my revenue in 2026?
Maybe you need to do a bunch of
resolves. Maybe you need to like uh
search the internet, maybe you need to
search the spreadsheet, things like
that. And there's a bunch of things that
don't need to go into the context of the
main agent. The main agent just needs to
see the follow result, right? And so,
that's a great sub agent task. Um I
don't have a dedicated sub agent side
here, but like yeah, they're very very
useful and I I think a great way to
think about things.
Um yeah, like there. And just to just to
build on that question actually.
For verification for example, you can
imagine doing that with a skill or a sub
agent. You might even want to have an
adversarial cybersecurity example. So, a
great one is one I haven't really gone
to town on it and not really have any
sympathetic relationship with the work
already done.
Uh it's a very I I I get it's a
spectrum, but do you like Are you saying
yes, you'd use a sub agent here? You'd
use a skill? How would you think about
this? Yeah, definitely. So, question on
like uh
do sub agents or I'm not sure how it
works to make sure for that.
Oh, sure. Okay, yeah, yeah.
Thank you. Appreciate it.
Um
Okay, yeah. Uh can you sub agents for
verification? Uh Yes. I I think this is
a pattern. I think like ideally, the the
best form of verification is rule-based,
right? You're like is there like a null
pointer or something?
Uh that's like easy verification. It It
doesn't length or compile. Like like as
many rules as you can, try and insert
them. And again, be creative, right?
Like for example, uh in Cloud Code, if
the agent tries to write to a file that
we know it hasn't read yet, like we
haven't seen the
we haven't seen it enter the read cache,
we throw it an error. We we tell it
like, "Hey, uh you haven't read this
file yet. Try reading it first, right?"
And that's an example of sort of like a
deterministic tool that we insert into
the verification step. And so, as much
as possible, like anytime you are
thinking about, you know, verification,
first step is like what can you do
deterministically? What like what like,
you know, outputs can you do? And again,
like when you're choosing which like
types of agents to make, the agents that
have more deterministic rules are
better. You know, like they just like
like it it just makes a lot of sense,
right? So,
um of course, as the models get better
and better reasoning, then you can have
these sub agents to check the work of
the main agent. The main thing there is
to like avoid uh context pollution. So,
you probably wouldn't want to like fork
the context. You'd probably want to
start a new context session and just be
like, "Hey, yeah, adversarially check um
the work of like this this output was
made by a junior analyst at McKinsey or
something. They graduated from
like not a great school like your GPA
like you know like like just like feed
it a bunch of stuff and then tell it to
critique it, right? Like that's like
one of the tools of a sub agent, right?
And so
yeah, the more you like
uh
yeah, as the models get better and
better that sort of verification will
become better as well. Um but doing it
deterministically is like a great start.
Yeah, question.
>> [clears throat]
>> Just a question about the verified work.
So
>> Yeah. Um
So
let's say we found null pointers, it's
probably easy to just say, "Okay, fix
it." But like, you know, let's say we
deploy to production and the client is
using it, that's not us that
they somehow get into a spot where the
whole spreadsheet is deleted. And so
like like
on what level do we need to bake in like
the ability to like undo tools? Cuz like
um
let's say the QA agent returns that
their spreadsheet is empty. Yeah. Not
necessarily is able to undo or so like,
like what was your advice there? Yeah,
so the question is like how do you think
about state and like undoing and
redoing, being able to um fix errors
basically, right? I think this is like
uh a really good question and honestly
another sort of like
um
like
when you think about like what are
agents good at, right? Like or what
problem domains are agents good at, how
reversible is the work is like a really
good intuition, right? So code is quite
reversible. You can just like go back,
you can undo the get history. We we come
with like, you know, these atomic
operations right out of the gate, right?
Like I use get constantly through cloud
code. I I don't type get commands
anymore, right? So
um that's like a really good example. A
really bad example is computer use,
[clears throat] you know, because
computer use
has is not reversible in state, right?
Like let's say you go to like
doordash.com and you add like the user
wants you to order a Coke and you add
order a Pepsi. Now like you can't just
go back and click on the Coke, you have
to like go to the cart and you have to
remove the Pepsi, right? And so your
mistake is like compounded this like you
know, this state and the state machine
has gotten more complex, right? And and
so like whenever we're dealing with like
very very complex state machines that
you can't undo or redo or it does become
harder, right? And I think one of the
questions for you as an engineer is like
can you turn this into a reversible
state machine kind of like you said, can
you store state between checkpoints such
that the user can be like, "Oh, my
spreadsheet is messed up right now, just
go back to the previous
checkpoint, right?" Potentially even can
the model go back to previous
checkpoints.
I I think someone had this like time
travel tool
that they were giving one of the coding
agents, which was kind of cool where
you're like it's like you can time
travel back to point before this
happened, you know what I mean?
It's kind of fun. I I think like all of
these tools some of them don't work that
well yet, but you know, we'll we'll get
there.
Um
yeah, thinking about state and
verification is is very useful, right?
So
um
Yeah, good question at the back.
Yeah,
um
I'm kind of curious about scale. Um
so what if the spreadsheet is like
millions of rows, millions and thou-
hundreds of thousands of columns, right?
Or it's just like any sort of database.
Like in that kind of situation, how
would you go about searching there's
obviously a context window.
You have the context window.
Yeah, this is great. Um I probably
should have done the spreadsheet example
as my coding example.
For for a preview, my coding like agent
is a Pokémon agent.
Um
probably spreadsheet would have been
better. Okay. Uh the question was what
if the spreadsheet is very big? If you
have a million rows, uh how do you think
about 100 columns and like 100 Yeah,
100,000 columns or 100 columns or
whatever. Like how do you think about
it, right? Like your database is also
very big. Like how do you how do you do
that?
Um
I think for all of these things,
one of course if the data becomes larger
and larger, it's just a harder problem.
Like you know, it just absolutely is.
Your accuracy will go down, right? Like
cloud code is worse in larger codebases
than it is in smaller codebases, right?
As the models get better, they will get
better at all of that. Um for all of
these, I would think about like how
would I do this? If I had a spreadsheet
that was like a million columns and a
million rows, what would I do? I I mean
I would need to start searching for it,
right? I would need to be like like if
I'm searching for revenue, I'd be like
searching control F revenue and then I'd
go check each of these like results and
I'd be like, "Is this right?" And then
like I'd see like a Is there a number
here? And then I'd probably keep a
scratch pad like a new sheet where I'm
like, "Hey, like
equals revenue equals this, you know?"
And and and store this reference and and
keep going. So I I think that's a good
way of thinking about it is like the
model shouldn't you should never like
read the entire spreadsheet into context
because it would it would take too much,
right? Like
um
you want to give it like the starting
amount of context. And it's also how you
work, right? Like let's say that you
open up the spreadsheet, what you see is
rows is this, right? You see like the
first 10 rows and the first like, you
know, 20 30 columns or something, right?
That's what you see. You don't load all
of it into context right away. You
probably have an intuition for like,
"Hey, I should load more of this into
context, right?" And and like, "Oh, I
should navigate to this other sheet,
right?" And this other sheet has more
data, right? Um
but you need to like sort of you gather
context yourself, right? And so the
agent can operate in the same way. It
can like navigate to these sheets, read
them, like try and like keep a scratch
pad, keep some notes, and keep going. So
that's how I would think about it. Uh
yeah, at the back. Yeah, so my question
is about managing context window. It
actually I guess relates to the previous
question. Um do you have a rule of thumb
for
you know, what fraction of the context
window do you use before you start
hitting diminishing returns or this
becomes less effective? Yeah, the
question is yeah, context management. Do
you have a rule of thumb for like
uh how much of the context window to use
before it becomes less effective? This
is actually I'd say
a pretty interesting problem right now.
Um
I think a lot of times when I talk to
people who are using cloud code, they're
like, "I'm on my fifth compact." I'm
like, "What?" Like like I've I like
almost have never done a compact before,
you know what I mean? Like I have to
like test the UX myself by like like
forcing myself to get compacted. Um
just because like I I tend to like clear
the context window very often, right?
When I'm using cloud code myself just
because like um at least in in code the
state is in the the files of the
codebase, right? So let's say that I've
made some changes, uh cloud code can
just look at my get diff and be like,
"Oh, [snorts] hey, these are the changes
you made." It doesn't need to know like
my entire chat history with it, you
know, in order to continue a new task,
right? And so in cloud code, I clear the
context very very often and I'm like,
"Hey, look at my outstanding get
changes. I'm working on this. Can you
help me extend it in this way, right?"
That's like a way of thinking about it.
And
when you're building your own agent,
like let's say we're building a
spreadsheet agent, it gets a little bit
more complex cuz your users are less
technical, right? And they don't know
what a context window is, right?
Um
that is like I'd say it's
a hard problem. I think there's like
some UX design there of like can you
reset the conversation state, right?
Like can you maybe every time the user
asks a new question, can you do your own
compact or something and can you like
summarize the context? Um does it like
in a spreadsheet
a lot of the state is in the spreadsheet
itself, so it probably doesn't need, you
know, to know the entire context. Um can
you store user preferences
um as it goes so that you remember some
of this stuff, you know, like there's a
lot of like again, like it's an art.
There's like so many different angles
and ways in which you can do this,
right? Um but yeah, you are trying to
like sort of minimize context usage. Um
you probably don't need sort of million
contexts or something, you know what I
mean? Like you just need good context
management like UX design. Yeah.
Um yeah. Um just I just wanted to ask
the sub agents were made to protect the
context of the core agent, right? That's
right. Yeah, sub agents were made to
protect the context.
>> would you be able to use multiple sub
agents and try to make a process where
we chunk up the spreadsheet in the case
where it's super large so then the
agents can kind of run through each
portion like parallel with each other?
Yeah, yeah. I mean um yeah, so like
one of the things I love about cloud
code is that we are like the best
experience for using sub agents. Like
especially sub agents with bash. It is
very very good. I didn't really quite
realize
uh all the pain.
Um I think if anyone's going to QCon, I
believe Adam Wolfe is giving a talk on
QCon about how we did the bash tool.
Adam's a legend and the bash tool did
such a good job. Um
when you're running parallel sub agents
at the same time, bash becomes like very
complex and there are lots of like like
race conditions and stuff like that. And
and so there's a lot of work that we
solved there, right? So this is
like one of the things I love about
cloud code is you can just be like,
"Hey, like spin up three sub agents to
do this task." And it will do that. And
in the agent SDK as well, you can just
ask it to do that. So number one,
uh sub agents are great primitive in the
agent SDK and I haven't seen anyone do
it as well. So that's like a big reason
to use it. Um
yes, generally you want it you want
these sub agents to preserve context.
Let's say you have if you have a
spreadsheet, you could potentially have
multiple read sub agents going on at the
same time, right? So maybe the main
agent is like, "Hey, can this agent read
and summarize sheet one? Can this agent
read the summary sheet two, can this
agent summarize sheet three, and then
they return their results, and then the
agent maybe spins off more sub agents
again, right? So, this is like another
knob you have. Um and I I think what I
want to say is like
there's like we've talked so many about
so much about like all these different
creative ways that you can like do
things. This is like the level at which
you should think about and should have
to think about your problem. You should
not really, in my opinion, think about
like uh like how like how do I spin off
a process to make a sub agent or like,
you know, like the system engineering
between like uh behind like what is a
compactor or something, right? So, like
we take care of all of this for you in
the harness so that you can think about
like, "Hey, what sub agents do I need to
spin off, right?" And like how do I
create a
genetic search interface and how do I
like verify its work? These are the
really core and hard problems that you
have to solve,
>> [laughter]
>> and any time you spend not solving these
problems is and solving like lower-level
problems, uh you're probably not
delivering value to your users, you
know? And and so,
um
yeah, I think sub agents, big fan of the
Agent SDK sub agents, yeah.
Uh yeah, good question. So, uh like we
have this
action and the verification path. So,
where exactly we need to put the
verification? In this example, I let's
say after generation of the SQL query,
yeah, I can verify it is the right query
generated or not, that is the one path.
Second path is like generation of the
query, directly executing, and once I
will get the output, then I will do the
verification. So, and how do how agent
can choose dynamically like which one is
the right path?
Yeah, so the question is like where do
you do verification?
Uh is it only at the end? Do you do it
in the middle? Like things like that. I
would say like everywhere you can, just
like constantly verification, right?
Like uh like I said, we do some
verification in the read step of the of
Cloud Code, right? So, that's like a
great example.
Um you can do it at the end, you should
absolutely do it at the end, but at any
other point, if you have rules or
heuristics especially, uh like if for
example, you're like, "Hey, one of my
rules is that you shouldn't do like
the the total number of columns you
should search is should be under 10,000
or under 1,000 or something." That's
like a a nice way of doing it, right?
Like similarly here, like maybe you
shouldn't be inserting like a huge like
row like of of values. Like give
feedback to the model, be like, "Hey,
chunk this up." Right? You throw an
error and give it feedback. And the
great thing about the model is like it
listens to feedback. It will read the
error outputs, right? And then it will
just keep going. So, yeah, verification
is definitely like I I know I have it in
this like as a sort of a loop, but um
it's definitely more like you
verification can happen anywhere and and
should happen in anywhere. Like like put
it in as many places you can. So,
um all right, I do need to start doing
some of the prototyping, but I'll take
one more question. So, right right here,
yeah. How do we say how do we form the
steps?
How do we say the agent that
go search first Yeah. and then do this
step and then do that step. How does it
loop actually step from the start point
to the
How do we do
You just tell it. So, like uh Like like
is there is there a system prompt or
Yeah, in the system prompt. Yeah, so
like with Cloud Code, we just give it
the bash tool and we're like, "Hey, like
gather context, read your files,
do stuff like run your linting." You
know what I mean?
Um and so yeah, again with the agent,
you don't need to enforce this, right?
You don't need to tell it, "Hey, like
you need to do this." Because like
sometimes it might not be necessary,
right? Like let's say that someone is
asking a read-only question for your
spreadsheet.
You don't need to like verify that uh
like your that there are no compilers,
right? Because there's you haven't done
any write errors, write write
operations, right? So,
um let the agent be intelligent and and
like in the same way that you would like
that same freedom when you're doing your
work, right? Uh you're trapped in this
box or whatever, like same way, right?
Uh so,
okay, cool. I I I do want to try and see
if I can do some prototyping now that we
have this uh
uh the the holder as well.
Um okay, yeah, execute only if we've
done a bunch of Q&A. Okay, prototyping.
Okay, let's say that you have an agent,
right? Like you want you want to build
an agent. You come out of this talk and
you're like, "Great, I have a bunch of
ideas. How how do I do this?" Um I think
what I can say overall is like building
an agent should be simple. Your agent at
the end should be simple, but simple is
not the same as easy, right? So, like it
should be very simple to get started,
and it is. Just go to Cloud Code.
Give Cloud Code some scripts and
libraries and uh custom custom Cloud
identity and ask it to do it, right?
That's what we're going to do, right?
Um
that's like it should be so easy to be
like, "Hey, this is my API. This is like
an API key.
Uh can you like go search like, you
know,
I don't [clears throat] know, like my
customer support tickets or something
and organize them by priority or
something like that, right?" And then
look at what Cloud Code does and and
iterate on it, right? And this is like a
great way of like just skipping to like
the hard domain-specific problems that
you have, right? So, you have a lot of
like domain problems, like how do you
organize your data, your genetic search,
how do you like put guardrails on your
database. These are all questions that
you can just start solving right away
with Cloud Code, right? And so, try and
like build something that feels pretty
good with Cloud Code, and I think
generally what I've seen is that you can
do this and get really good results just
out of the bat using Cloud Code locally,
right? And and you should have high
conviction by the end of it, right? And
so, um
yeah, I think like
>> [laughter]
>> I forgot this
more info watch my AI engineer talk. Uh
this is like a deck for internal that
we're using.
Um okay, so,
uh yeah, I'm going to be inserting this.
So, yeah yeah, you're getting what we're
what we show customers, right? So,
um
okay, uh yeah, so yeah, use use Cloud
Code.
Uh again, simple,
but simple is not easy, right? So, like
the amount of code in your agent should
not be like super large. Doesn't need to
be huge, doesn't need to be extremely
complex, but it does need to be elegant.
It needs to be like what the model
wants. You want to have this interesting
insight. Let's turn the the model into a
SQL query. Uh let's turn the spreadsheet
into a SQL query and then go from there,
right? So, um
think about it that way, and Cloud Code
is like a great way of doing that. So,
okay. Uh let's make a Pokémon agent,
right? This is what we're going to do.
Uh Pokémon is a game with a lot of
information. There are thousands of
Pokémon, each has a ton of moves.
Um
uh we want to be pretty general, and so
there is actually like a Poké API.
Um and the reason I chose Pokémon is
just cuz like I know that you guys have
your own APIs as well, right? And
they're all like very unique, right? And
uh so, I want to choose something with
the kind of complex API that I haven't
tried before.
Um
So, the Poké API has like, you know, you
can search up Pokémon like Ditto. Uh you
can search up like items and things like
that. Um and so, it's got this like
yeah, this custom API you've got uh
everything in the games, right? So, um
and yeah, like one of the quest things
your agent might want your user might
want to do is make a Pokémon team,
right? I love Pokémon. I know very
little about making an interesting
Pokémon team for competitive play. Uh
could my agent help me with that? That'd
be that'd be cool, right? So, um my goal
is to make an agent that can chat about
Pokémon, and then we will like, you
know, see what we can do, right? And and
and how far we get. So,
um I've done like some of this work
already, and I will like open up and
show you. So, um
the first step and the prompt here is
like the first step is I'm I'm going to
do mostly code generation for this,
right? And so,
um let me
Is that going to be on GitHub somewhere?
Uh actually it is.
Uh yeah, it's on my personal GitHub. Oh
yeah, I was going to commit all of this
as well.
Yeah.
Um yeah, yeah, so uh
I think my personal GitHub is, let's
see,
all right. Is it a secure GitHub or does
it have malware in it? [laughter]
It you you guys are AI engineers, you
know? Like if you get owned, that's
that's your fault. Um
yeah, so
um yeah, you can you can clone clone
this if you'd like. Um
I need to push the last changes. So,
okay, so um
yeah, can can you guys see this? Should
I put it in dark mode instead or is this
fine? Like um Dark mode. Dark mode?
Okay.
>> [laughter]
>> Okay, is this better?
Yeah. No?
You want a different dark mode?
Dark hard. Okay, I don't think this is
good enough for you guys. Um
Okay, yeah, let's
I How does this work? Can you guys still
hear me
Yeah.
Okay.
Um okay, so here's an example of like
I've taken the prompt I gave it was
"Hey, I
go search Poké API for its API and
create a TypeScript library." Right? And
so, this is all by coded.
Um and so, you can see here that it's
created this like interface for Pokémon,
right? And so, it's created like this
Pokémon API. I can get by name, I can
list Pokémon, I can get all Pokémon, I
can get species and abilities and stuff
like that. And so, like this is just a
prompt that I give it, right? And
generated this like TypeScript API. It
also did it for moves. Um and then it's
created this
um
like uh
it's created this like API that I can
use. Import PokéAPI, right? From the
PokéAPI SDK, and uh yeah, you can see
like sort of how it's like set set this
up. And uh
now, in contrast, right? And and so,
this is the Claude that I made, right?
This is the TypeScript SDK for the
PokéAPI.
Um
this is like the the modules in the
PokéAPI. Here are some of the key
features.
Um
Uh I'm asking it to write scripts in the
examples directory, and then it will
execute those scripts to help me with my
queries, right? Um and I give it some
example scripts. It doesn't always need
all this information, right? Like uh but
yeah, fetching Pokémon, listing the
resources, getting data, and stuff like
that. So, this is like my agent, really.
It's like a prompt I gave it to generate
a TypeScript library, and then this
Claude that I made, and I I can chat
with it in Claude Code. I'll also show
you a version of it that is just tools,
right? So, here I'm using the messages
completion API, right? And I've given it
a bunch of tools from the API. So, like
get Pokémon, get Pokémon species,
uh get Pokémon ability, get Pokémon
type, I get move. So, you define all
these tools, and you can see that like
you know, I also just gave it a prompt
and told it to make the tools. Um it
doesn't want to make 100 tools, right?
Like there's a ton of Smogon or sorry,
um
PokéAPI data. Um
but like it you know, there's only so
many parameters it can do. So, it's got
this like tool call, and now
um
and I I made like a little chat
interface with it, right? So, let me now
go here and say like
uh
this is my tool calling
um
Did you push the latest one?
Did I miss?
Great. So, yeah, here we've got this
chat.ts, right?
Um
I I use Bun when I'm prototyping stuff,
just cuz like I don't want to compile
from TypeScript to JavaScript. Um
and uh
again, Bun has like linting built into
it. Uh
it's a way of like simplifying for the
agent, so the agent doesn't need to
remember to compile. But TypeScript is
better for generation, cuz it has types,
right? So, I'm going to start this like
Bun chat, and then I'm going to try
like, okay, what are the generation
two water Pokémon?
Um
And
you'll see that it's it's starting to
like search, and I'm logging all the
tool calls here. This is very very
important, right? Because like it needs
to like do the tool calls, and so you
can see that what it's doing is like
it's searching a bunch of Pokémon.
Um
and then it told me, okay, here are the
water Pokémon for gen two, right? It's
got Totodile, Croconaw, Feraligatr. You
can see sort of like how it's
like in between each step it's thinking
through
um
the previous steps, right? Now, like
let's say that I want to do
with Claude Code
I think I might need to
uh
I really need to delete this example.
The um
Oh, yeah.
Small question. How do you log the the
tool calls? Is that
Is it just just an argument you can
pass?
>> Oh, yeah, this is um this is like in the
normal API, right? So, I just like uh
in the model, every time it logs it, I
just call this. This is in the like
normal Anthropic API. Um
In the SDK, I I'll get back to get to
the SDK. Um it's just like you just log
every assistant message, so
um
just doing console.log split. Does that
make sense or or yeah?
Okay. Yeah, well. So, so the chat
interface you were showing, is that just
using the regular API or
>> Yeah, that's using the regular API.
>> So, not the agent SDK. Not the agent
SDK. Yeah, yeah, yeah. And so,
what I'm going to do here is
um here, I'm going to delete this script
because I don't want it to cheat.
Um but okay, so here you you know that
um I've I'm just opening Claude Code.
I've created a bunch of files here. I'm
going to say like, can you tell me all
the generation two water Pokémon?
Um and then we'll see what it can do,
right? So,
um
>> [clears throat]
>> I forget if I need to prompt it to write
a script or something. I think it'll be
fine. We'll We'll see what happens. Do
you mind going to the core SDK file and
just showing talked about different
context and then action and then
verification? Can you show that in the
code and how we're configuring the tool
description? Yeah, so uh we haven't done
the SDK part yet.
So, so far I've just
put put some APIs in Claude Code. Yeah,
yeah, yeah. That's right. I thought I
missed that. This is why No, no, no,
yeah, yeah, yeah, of course. Okay.
Um
but yeah, so okay, you can see here
um it's it's given me a lot more, right?
And um
Yeah, it's given me a lot more. So, it
it it's it's saying there's 20 water
Pokémon, right? And I think this is
roughly right. I've like
um
Uh what did it do?
Oh, I think it just knows. Okay.
Yeah, that's funny. Live demo this.
Um
Anyways, uh
Yeah, Pokémon is slightly in
distribution, which is which is I I
guess good.
>> [laughter]
>> Um
But yeah, so like what what it will do
is like it will try and like write like
a script, and
uh because you don't want it to think as
much, right? So, here it's like, okay,
what I'm going to do is
um let's see. Gen two water type
Pokémon. Yeah.
Where is it?
Okay, so yeah, you can see here it it
knows like, okay, the start of the
generations. It fetches these
uh for API.
Um I guess it's decided not to use like
my Google API here.
Um
And then uh
yeah, and and then runs it, right? So,
um
I think I need to like improve the
Claude that I made for this. But
anyways, you can see that like it's able
to like check 200 plus Pokémon, and then
check for their type, and and you know,
get their get their information, right?
So, this is like
uh just a quick example on like how to
do code gen and how to use Claude Code
to do it, right? So,
we'll run this script, and then like
uh um like keep going, right? So,
uh it will give me the output. And um
yeah, basically what I want to show,
let's see, we have
roughly 15 minutes left.
Um
Just have it play Pokémon.
Just have it play Pokémon. Yeah, yeah.
Actually, this is one of the demos I was
thinking of doing.
Um Claude Code plays Pokémon. So, like
let's say you want to do like an agentic
version of Claude plays Pokémon, how
would you do it?
Um
What you would do, I think, is like you
would give it access to the internal
memory of the uh the ROM, right? And so,
let's say that it wanted to find its
party, it could search that in memory.
And Pokémon Red is like a very well in
distribution
uh reverse engineered uh game, right?
And so, it could search in memory to be
like, hey, these are the Pokémon.
Um
these are like this is how I figure out
where the map is, this is how I navigate
it. Right? So, this is like maybe
actually I have to tell the reader if
you want to try it out. It's like
um there is like a Node.js GBA emulator.
Um
I think I have to legally say you have
to go buy Pokémon Red and try it. Um
but yeah, I think like
uh Yeah, good example. Anyways, here.
So, it's it's fetched all of them, and
it it's listed all their types, and um
yeah, you can see how it's like used
code generation to do this, right? So,
um a quick example of using Claude Code
to prototype this.
Um Now, there can be like more
interesting like data here. So,
um
I do want to leave time for example. So,
I I think I'll just sort of like for
questions. So, I'll just sort of go
through like an example.
Let's say you're making competitive
Pokémon. Competitive Pokémon has a lot
of different variables and data. So,
this is like a
a
text file from this online like a
library, basically, which stores like
all of the Pokémon and their like moves
and who they work well with and don't
work well with, and you know, like who
they're countered by and all of these
things, right? So, there's a ton of data
here, right? And it's all in text file.
Um
which is actually pretty good for Claude
Code, right? Because I can say like,
okay,
um hey, I'm going to give it a little
bit more data. Normally, I put this in
the
um check the data folder. Tell me
I I want to make a team around Venusaur.
Can you give me some suggestions based
on the Smogon data?
Um
And Smogon is like this online API. And
so, I'm I'm not entirely sure what it'll
do here yet. I haven't done this career
before. Uh but we'll see. I think it'll
be it'll be fun. Um
Over there.
That's Oh, I see.
Um
Yeah, but what I wanted to do is sort of
graph through this this data, right? And
and sort of figure out from itself from
first principles, not having seen this
data before, how can I like answer my
query, right? So, um
while it does does that, I'll I'll take
any questions. Yeah?
Uh
So, great workshop. Uh and so, this is
like really on top of Cloud Code.
And so, my question is
if we were to deploy this
customer-facing
app,
are we supposed to have Cloud Code
running in like uh like the swarm, or
are we somehow able to take the Cloud
Code part out, just use Cloud and the
Agent SDK?
Mm, yeah. So, let me show you like very
quickly like what the
what it looks like to use the Agent SDK
here. Um so,
I've already done this file system,
right? And again, I want you to think
about the file system as a way of doing
context engineering, right? Like this is
like a lot of the inputs into the agent.
So, my actual agent file is like 50
lines, right? Um and it's mostly just
like
random like boilerplate, right? Like I
guess yeah, it's decided to stop it from
uh writing scripts outside of the custom
scripts directory.
Again, so we back code it. So, um
yeah, you can see like it just runs this
query, takes in the working directory,
um and uh
like like runs it in a loop, right? And
so,
probably I'd want to like turn into like
some allowed tools here and stuff, but
it it's very simple. And and so, um
if I were to like productionize this,
the first step I do is like, okay, I
I've tested it on Cloud on Cloud Cloud
Code. It seems to do pretty well. I
write this file, then I put it
There are two ways to do it. So, one is
I do think that
like
local apps might be coming back with AI
because I think that like there's such
an overhead to running it. Like for
example, Cloud Code is a front-end app,
right? Like it works on your computer.
So, maybe the way I ship this as a
Pokémon app is like, hey, I have like an
app that you install and it works
locally on your computer, and it's
running scripts. I think that's one way
of doing it, right? Um
the other way is, yeah, you have you
[clears throat] host it in a sandbox. Um
and again, there is a bunch of different
sandbox providers that make it really
easy. Like Cloudflare has a good example
um of using the Agent SDK, and it's just
like
sandbox.start,
you know? And then like bun
agent.ts, and that's kind of all it
takes, right? Like it's like like
they've abstracted away a lot of it. Um
so, you run like the sandbox,
um and then you communicate with it.
And um yeah, I think there is like some
very interesting stuff that I'm not sure
I had time to get to, but um
like I I think some interesting
questions are like um
Yeah, like how do you do this sort of
like service? Now, we're just spinning
up a sub like a sandbox per user. Um
there's a lot of like I'd say best
practices to solve here. One thing I
just want to call out for you guys to
think about um if you're making an agent
with a UI, like let's say that you have
uh yeah, my
Pokémon agent, and I wanted to have a UI
that is adaptable to the user, right?
Like maybe some users are doing team
building, some users are helping you
with their games, some users just want
pictures of Pokémon. How would How would
I have an agent that adapts in in real
time to my user, right? Um
the way I would do it is in my sandbox,
I would have a dev server, right? And
the dev server would expose a port. Um
it would run on bun or node or
something. It would like expose a port.
The agent could edit code, and it would
live refresh. And and your user would be
interacting with that website. This is
how a lot of like site builders like
lovable and stuff work, right? They they
use sandboxes, and they send host
essentially dev server. And so, thinking
about this for your users, if you want a
customized interface, this is a great
way to do it. Um
Okay, let's see what
Let's see what it did.
Um
Okay, cool. Okay, so
um it's like written this like script.
It's generated like
showed me some base stats and suggested
a like um
uh a move set and some teammates, and
you can see sort of like
See, what did it do?
Um control
um
Yeah, okay. So, you can see here what it
started doing is like it started
searching for Venusaur, right? And it
started finding
uh those types the the like those
Pokémon. And when it does that, it also
gets
other Pokémon that mentioned Venusaur.
So, it gets like its teammates and its
counters and stuff, right? And it's sort
of over this time found interesting
Pokémon, right? That like it might work
with, right? So, it's done a bunch of
these searches, and it's got this
profile. It's found those common
teammates and and written this script to
to analyze it, right? And so, this is
all based on a text file. Of course, I
could have preprocessed the text file a
little bit more. Um but yeah, it's like
done this sort of like interesting
um an analysis for me, right? And again,
I'll I'll push up more code to the
GitHub repo, and
um
I'll also tweet about this. I'm on
Twitter. I'm uh TRQ212.
Uh I tweet a lot. So, uh definitely like
mostly about Agent SDK stuff. Um but
yeah, we have about 8 minutes left. So,
I want to spend the rest of the time
taking questions about kind of anything,
you know? And I'm sorry we didn't get to
do more prototyping.
But uh yeah. Yeah, I was going to say
with the Cloud Play, can you sort of
plug this in with that? Just to see if
the agent will uh be more selective with
the teammates and uh
try to capture Yeah, I would put it in
in Cloud Play's Pokémon. Yeah, yeah. I
do want to make Cloud Play's Pokémon. I
think that would be fun. Yeah, yeah. I I
think Cloud Play's Pokémon, I think we
try and keep it like a pure reasoning
task as much as possible. Yeah. Uh other
questions, yeah? I was curious about how
people are monetizing Cloud Code SDK.
Mm.
Yeah.
Yeah, I I do think overall, especially
right now, agents are kind of pricey.
You know what I mean? Because like um
the models are have just started to get
agentic. We really focus on like having
the most intelligent models, you know?
And like you generally this is just like
an overall like SaaS business software
thing. You'd rather charge fewer people
more money that really have like a hard
problem, you know? And so, I think this
is still good. Like you probably should
find um
you know, these hard use cases, but I
would say like number one, make sure
you're solving a problem that people
want to pay for, right? It's is like the
number one step, right? And then number
two,
um
yeah, I think you could do subscription
or token based. I I think this kind of
comes down to like how much you expect
people to use your product uh versus
like how much you expect them to like
use it occasionally. Like Cloud Code,
obviously people use a lot, and in order
to like we do a mix of like if we give
you some rate limits, and if you exceed
it, we do uh usage-based pricing. Um I
think that like yeah, it's very like
dependent on your own user base and kind
of like what they will do. But I will
say monetization is something you should
think about up front and design your,
you know, agent around because it's hard
to walk back these processes.
Um
Yeah, back there. Um I haven't heard you
talk at all about hooks, and I'm curious
to hear your take on
Uh yeah, there's so much to talk about.
Um
hooks are great. We we we do ship with
hooks. Um hooks are a way of doing
deterministic verification in
particular, or inserting context. So, um
you know, we fire these hooks as events,
and you can register them in the A in
the Agent SDK. There's like a guide on
how to do that. Um examples of things
you might use hooks for is like, for
example, um
yeah, you can run it to verify the like
a spreadsheet each time. Uh you can also
look like let's say I'm working with an
agent, and
uh I'm the agent is doing some
spreadsheet operations, and the user has
also changed the spreadsheet. This is an
interesting like place to use a hook,
cuz you could be like, hey, has
after every tool call, insert changes
that the user has made. Uh and you and
so, you're giving it kind of live
context changes
um in an interesting way. So, um
Yeah, I think
uh yeah, there there's more stuff on
like the docs about hooks. Um
I and happy to like talk about it
afterwards as well. Yeah, more
questions, yeah? So, when I'm calling
the Agent SDK, what am I doing? Yeah.
>> Let's say as an example, I go through
this data
in Cloud Code. Yeah. Then I realize,
okay, it's working. Yeah. And I want to
take this same conversation that I've
already done because I'm going through a
few questions.
Yeah. And convert that into an agent.
Okay. Uh which is that I followed a few
steps. Now, it's actually working. I
don't want to rewrite all of the code to
write the Agent SDK
>> [clears throat]
>> like it
It's like because it works. Yeah, sure.
Yeah, so like let's say you've done this
prototyping. You found something that
works. What I would do is like I'd
summarize the cloud.md. Like obviously
like when I tried doing this one time,
it like didn't use my API directly, and
it wrote JavaScript. I should have been
more specific in my cloud.md to be like,
hey, you should use this. Um [snorts]
I Yeah, I I think like so, that's one
thing.
Um the second thing is
uh
Yeah, just summarize into the cloud.md,
have the helper scripts that you need,
and then like write something like this
agent.js
for like to run the test. Yeah.
Yeah, more question yeah in the gray.
Yeah, I
try to put it for money and I think it's
fine. It also takes the output of the
script to answer. It tries a couple
times like my test case is very good I
wrote it. Sure, sure. It tries twice and
then it's like well here's your
comparison table but it's just it's uh
do you have any advice for that kind of
problem? Yeah, this this is a good
question and and you know like I'm
I think there is some messiness right?
Like I I think one of the things if an
agent knows an answer
um and you want to like sort of like
fight it kind of to be like okay like no
it's generation nine now and like you
know sort of stuff has changed and
there's like this new like paradigm like
um
this is hard I actually think. One of
the ways of doing that is hooks. So you
can say for example like hey
uh don't if you've like returned a
response without writing a script, you
know, you can check that. You can be
like give feedback to be like please
make sure you write a script. Please
make sure you read this data, right? And
and you can use hooks to like give that
feedback in in the same way that in
cloud code
um we have these like rules like make
sure you read a file before you write to
it, right? so add some determinism. It
can definitely be like I said it's an
art you know sometimes you know yeah
maybe like like writing code I guess
probably.
Um
>> [laughter]
>> yeah, in the gray. How are you guys
dealing with like large code bases some
of them are working like a 50 million
plus line code base and so Yeah. grep
tool doesn't work really
so I'm having to build like my own like
semantic indexing type thing to kind of
help with that right? Sure. Is there any
kind of like added product maybe
thinking about how that can be more
native to the product like you know in a
couple months is the thing I'm writing
just going to go away or like how how do
you guys think about that?
Okay, your last question in a couple
months do you think it'll go away?
Generally yes. Yeah,
>> [laughter]
>> anytime you ask about AI yeah.
I think I think that
um
Semantic search this is a cloud code
question more than an agent SDK question
but happy to answer it like
um
we
you know there are trade-offs with
semantic search it's more brittle I
think you have to like index and and and
search and we it's not necessary the
model's not trained on semantic search
and so I think that's sort of like a
problem like you know grep is trained on
because it's like it's easy to do that
but like semantic search you're
implementing your bespoke query.
Um
for like very large code bases you know,
we have lots of customers that work in
large code bases. I think what I've seen
is sort of like they just do like
good cloud dot MDs. You start in you
know, try and make sure you start in the
directory you want. Have like good like
verification steps and hooks and links
and things like that and so
you know, that's what we do. We don't
have you know, a custom we we dogfood
cloud code right? So
um yeah.
Okay, yeah last question. We have to
close unfortunately actually. So we'll
Thank you everyone.
>> [applause]
[music]
```
