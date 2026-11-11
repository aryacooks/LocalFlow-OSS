//! Spoken emoji: "that's hilarious laughing emoji" → "that's hilarious 😂".
//!
//! Only phrases that END in the word "emoji" (or "emojis") are touched, so the name
//! is never guessed from ordinary prose — "laughing" alone stays a word. The words
//! right before "emoji" are looked up in the table below, longest phrase first, so
//! "thumbs up emoji" wins over "up emoji". An unknown name is left exactly as spoken
//! rather than swapped for a near miss.
//!
//! The table is spoken names, not Unicode names: people say "laughing emoji" for 😂,
//! not "face with tears of joy", so several everyday names map to one emoji.

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;

/// Longest name, in words, that a lookup will try ("smiling face with heart eyes").
const MAX_NAME_WORDS: usize = 5;

#[rustfmt::skip]
const EMOJI_NAMES: &[(&str, &str)] = &[
    // — laughing / happy —
    ("laughing", "😂"), ("laugh", "😂"), ("crying laughing", "😂"), ("laughing crying", "😂"),
    ("tears of joy", "😂"), ("face with tears of joy", "😂"), ("joy", "😂"), ("lol", "😂"), ("lmao", "😂"),
    ("rolling on the floor laughing", "🤣"), ("rofl", "🤣"), ("rolling laughing", "🤣"),
    ("grinning", "😀"), ("grin", "😁"), ("big smile", "😃"), ("beaming", "😁"),
    ("smile", "😊"), ("smiling", "😊"), ("smiley", "😊"), ("smiley face", "😊"), ("smiling face", "😊"),
    ("happy", "😊"), ("happy face", "😊"), ("blush", "😊"), ("blushing", "😊"),
    ("sweat smile", "😅"), ("nervous laugh", "😅"), ("nervous", "😅"),
    ("slightly smiling", "🙂"), ("slight smile", "🙂"), ("upside down", "🙃"), ("upside down face", "🙃"),
    ("wink", "😉"), ("winking", "😉"), ("winky face", "😉"), ("tongue out", "😛"), ("tongue", "😛"),
    ("crazy", "🤪"), ("zany", "🤪"), ("goofy", "🤪"), ("silly", "🤪"),
    ("cool", "😎"), ("sunglasses", "😎"), ("nerd", "🤓"), ("nerd face", "🤓"),
    ("star struck", "🤩"), ("starstruck", "🤩"), ("star eyes", "🤩"), ("halo", "😇"), ("angel", "😇"),
    ("relieved", "😌"), ("hug", "🤗"), ("hugging", "🤗"), ("hugs", "🤗"), ("salute", "🫡"), ("saluting", "🫡"),
    // — love —
    ("heart eyes", "😍"), ("heart eyes face", "😍"), ("smiling face with heart eyes", "😍"), ("in love", "😍"),
    ("kiss", "😘"), ("kissing", "😘"), ("blowing a kiss", "😘"), ("blowing kiss", "😘"), ("kissy face", "😘"),
    ("smiling face with hearts", "🥰"), ("hearts face", "🥰"), ("adoring", "🥰"),
    ("heart", "❤️"), ("red heart", "❤️"), ("love heart", "❤️"),
    ("orange heart", "🧡"), ("yellow heart", "💛"), ("green heart", "💚"), ("blue heart", "💙"),
    ("purple heart", "💜"), ("black heart", "🖤"), ("white heart", "🤍"), ("brown heart", "🤎"), ("pink heart", "🩷"),
    ("broken heart", "💔"), ("heartbreak", "💔"), ("sparkling heart", "💖"), ("two hearts", "💕"),
    ("heart on fire", "❤️‍🔥"), ("love letter", "💌"),
    // — sad / upset —
    ("sad", "😢"), ("sad face", "😢"), ("crying", "😢"), ("cry", "😢"), ("tear", "😢"),
    ("sobbing", "😭"), ("sob", "😭"), ("loudly crying", "😭"), ("bawling", "😭"),
    ("pleading", "🥺"), ("pleading face", "🥺"), ("puppy eyes", "🥺"), ("puppy dog eyes", "🥺"),
    ("disappointed", "😞"), ("pensive", "😔"), ("worried", "😟"), ("frowning", "☹️"), ("frown", "☹️"),
    ("angry", "😠"), ("mad", "😠"), ("rage", "😡"), ("furious", "😡"), ("pouting", "😡"),
    ("swearing", "🤬"), ("cursing", "🤬"), ("steam", "😤"), ("triumph", "😤"), ("huffing", "😤"),
    ("scream", "😱"), ("screaming", "😱"), ("shocked", "😱"), ("fearful", "😨"), ("scared", "😨"),
    ("anxious", "😰"), ("tired", "😫"), ("weary", "😩"), ("exhausted", "😩"), ("sleepy", "😪"),
    ("sleeping", "😴"), ("sleep", "😴"), ("asleep", "😴"), ("yawn", "🥱"), ("yawning", "🥱"),
    ("sick", "🤢"), ("nauseated", "🤢"), ("vomiting", "🤮"), ("throwing up", "🤮"), ("mask", "😷"),
    ("hot", "🥵"), ("hot face", "🥵"), ("cold", "🥶"), ("cold face", "🥶"), ("freezing", "🥶"),
    ("dizzy", "😵‍💫"), ("melting", "🫠"), ("melting face", "🫠"),
    // — thinking / reactions —
    ("thinking", "🤔"), ("thinking face", "🤔"), ("hmm", "🤔"), ("think", "🤔"),
    ("eye roll", "🙄"), ("rolling eyes", "🙄"), ("eyes rolling", "🙄"),
    ("smirk", "😏"), ("smirking", "😏"), ("unamused", "😒"), ("expressionless", "😑"),
    ("neutral", "😐"), ("neutral face", "😐"), ("no mouth", "😶"), ("zipper mouth", "🤐"), ("shush", "🤫"), ("shushing", "🤫"),
    ("grimace", "😬"), ("grimacing", "😬"), ("yikes", "😬"), ("awkward", "😬"),
    ("surprised", "😮"), ("wow", "😮"), ("astonished", "😲"), ("open mouth", "😮"), ("flushed", "😳"), ("embarrassed", "😳"),
    ("mind blown", "🤯"), ("exploding head", "🤯"), ("monocle", "🧐"), ("raised eyebrow", "🤨"),
    ("money mouth", "🤑"), ("drooling", "🤤"), ("yum", "😋"), ("yummy", "😋"), ("delicious", "😋"),
    ("liar", "🤥"), ("lying", "🤥"), ("party face", "🥳"), ("partying", "🥳"), ("partying face", "🥳"),
    ("cowboy", "🤠"), ("clown", "🤡"), ("devil", "😈"), ("smiling devil", "😈"), ("imp", "👿"),
    ("skull", "💀"), ("dead", "💀"), ("ghost", "👻"), ("alien", "👽"), ("robot", "🤖"), ("poop", "💩"), ("pile of poo", "💩"),
    ("eyes", "👀"), ("eye", "👁️"), ("brain", "🧠"), ("see no evil", "🙈"), ("see no evil monkey", "🙈"), ("monkey", "🐵"),
    ("shrug", "🤷"), ("shrugging", "🤷"), ("facepalm", "🤦"), ("face palm", "🤦"),
    // — hands —
    ("thumbs up", "👍"), ("thumb up", "👍"), ("thumbsup", "👍"),
    ("thumbs down", "👎"), ("thumb down", "👎"), ("dislike", "👎"),
    ("ok", "👌"), ("okay", "👌"), ("ok hand", "👌"), ("okay hand", "👌"), ("perfect", "👌"),
    ("clap", "👏"), ("clapping", "👏"), ("clapping hands", "👏"), ("applause", "👏"),
    ("pray", "🙏"), ("praying", "🙏"), ("prayer", "🙏"), ("praying hands", "🙏"), ("folded hands", "🙏"),
    ("high five", "🙏"),
    ("wave", "👋"), ("waving", "👋"), ("waving hand", "👋"),
    ("raised hands", "🙌"), ("raising hands", "🙌"), ("hands up", "🙌"), ("hooray", "🙌"),
    ("muscle", "💪"), ("flex", "💪"), ("flexing", "💪"), ("biceps", "💪"), ("strong", "💪"), ("strength", "💪"),
    ("fist bump", "👊"), ("fist", "✊"), ("punch", "👊"), ("handshake", "🤝"),
    ("peace", "✌️"), ("peace sign", "✌️"), ("victory", "✌️"), ("crossed fingers", "🤞"), ("fingers crossed", "🤞"),
    ("rock on", "🤘"), ("horns", "🤘"), ("call me", "🤙"), ("shaka", "🤙"),
    ("point up", "☝️"), ("pointing up", "☝️"), ("point right", "👉"), ("pointing right", "👉"),
    ("point left", "👈"), ("pointing left", "👈"), ("point down", "👇"), ("pointing down", "👇"),
    ("middle finger", "🖕"), ("writing", "✍️"), ("nail polish", "💅"), ("open hands", "👐"), ("heart hands", "🫶"),
    // — celebration / symbols —
    ("fire", "🔥"), ("lit", "🔥"), ("flame", "🔥"), ("hundred", "💯"), ("one hundred", "💯"), ("100", "💯"),
    ("hundred points", "💯"), ("party", "🎉"), ("party popper", "🎉"), ("tada", "🎉"), ("celebrate", "🎉"),
    ("celebration", "🎉"), ("confetti", "🎊"), ("balloon", "🎈"), ("gift", "🎁"), ("present", "🎁"),
    ("birthday", "🎂"), ("birthday cake", "🎂"), ("cake", "🍰"), ("trophy", "🏆"), ("medal", "🥇"), ("gold medal", "🥇"), ("crown", "👑"),
    ("sparkles", "✨"), ("sparkle", "✨"), ("star", "⭐"), ("glowing star", "🌟"), ("shooting star", "🌠"),
    ("rocket", "🚀"), ("lightning", "⚡"), ("lightning bolt", "⚡"), ("zap", "⚡"), ("boom", "💥"), ("explosion", "💥"),
    ("check", "✅"), ("check mark", "✅"), ("checkmark", "✅"), ("tick", "✅"), ("green check", "✅"),
    ("cross", "❌"), ("cross mark", "❌"), ("x", "❌"), ("red x", "❌"),
    ("warning", "⚠️"), ("alert", "🚨"), ("siren", "🚨"), ("stop", "🛑"), ("stop sign", "🛑"), ("no entry", "⛔"),
    ("question", "❓"), ("question mark", "❓"), ("exclamation", "❗"), ("exclamation mark", "❗"), ("bang", "❗"),
    ("plus", "➕"), ("minus", "➖"), ("arrow", "➡️"), ("right arrow", "➡️"), ("left arrow", "⬅️"),
    ("up arrow", "⬆️"), ("down arrow", "⬇️"), ("recycle", "♻️"), ("infinity", "♾️"),
    ("green circle", "🟢"), ("red circle", "🔴"), ("yellow circle", "🟡"), ("blue circle", "🔵"),
    ("light bulb", "💡"), ("lightbulb", "💡"), ("idea", "💡"), ("bulb", "💡"),
    ("money", "💰"), ("money bag", "💰"), ("dollar", "💵"), ("cash", "💵"), ("gem", "💎"), ("diamond", "💎"),
    ("pin", "📌"), ("pushpin", "📌"), ("paperclip", "📎"), ("memo", "📝"), ("note", "📝"), ("notes", "📝"),
    ("calendar", "📅"), ("clock", "⏰"), ("alarm", "⏰"), ("hourglass", "⏳"), ("lock", "🔒"), ("key", "🔑"),
    ("bell", "🔔"), ("megaphone", "📣"), ("loudspeaker", "📢"), ("mail", "📧"), ("email", "📧"), ("envelope", "✉️"),
    ("phone", "📱"), ("laptop", "💻"), ("computer", "💻"), ("camera", "📷"), ("tv", "📺"), ("television", "📺"),
    ("chart", "📈"), ("chart up", "📈"), ("chart increasing", "📈"), ("graph", "📈"), ("chart down", "📉"),
    ("book", "📖"), ("books", "📚"), ("magnifying glass", "🔍"), ("search", "🔍"), ("link", "🔗"),
    ("hammer", "🔨"), ("wrench", "🔧"), ("tools", "🛠️"), ("gear", "⚙️"), ("bug", "🐛"), ("package", "📦"),
    ("music", "🎵"), ("musical note", "🎵"), ("headphones", "🎧"), ("microphone", "🎤"), ("mic", "🎤"),
    ("game", "🎮"), ("video game", "🎮"), ("controller", "🎮"), ("dice", "🎲"), ("target", "🎯"), ("bullseye", "🎯"),
    ("speech bubble", "💬"), ("zzz", "💤"), ("sweat", "💦"), ("sweat drops", "💦"), ("dash", "💨"), ("wind", "💨"),
    ("flag", "🚩"), ("red flag", "🚩"), ("checkered flag", "🏁"), ("finish", "🏁"),
    // — nature / weather —
    ("sun", "☀️"), ("sunny", "☀️"), ("moon", "🌙"), ("cloud", "☁️"), ("rain", "🌧️"), ("rainy", "🌧️"),
    ("umbrella", "☂️"), ("snow", "❄️"), ("snowflake", "❄️"), ("snowman", "⛄"), ("rainbow", "🌈"),
    ("earth", "🌍"), ("globe", "🌍"), ("world", "🌍"), ("tree", "🌳"), ("christmas tree", "🎄"), ("plant", "🌱"),
    ("seedling", "🌱"), ("flower", "🌸"), ("cherry blossom", "🌸"), ("rose", "🌹"), ("sunflower", "🌻"),
    ("tulip", "🌷"), ("leaf", "🍃"), ("four leaf clover", "🍀"), ("clover", "🍀"), ("cactus", "🌵"),
    ("ocean", "🌊"), ("water wave", "🌊"), ("volcano", "🌋"), ("mountain", "⛰️"), ("droplet", "💧"),
    // — animals —
    ("dog", "🐶"), ("puppy", "🐶"), ("cat", "🐱"), ("kitty", "🐱"), ("mouse", "🐭"), ("rabbit", "🐰"), ("bunny", "🐰"),
    ("fox", "🦊"), ("bear", "🐻"), ("panda", "🐼"), ("koala", "🐨"), ("tiger", "🐯"), ("lion", "🦁"), ("cow", "🐮"),
    ("pig", "🐷"), ("frog", "🐸"), ("chicken", "🐔"), ("penguin", "🐧"), ("bird", "🐦"), ("owl", "🦉"),
    ("unicorn", "🦄"), ("horse", "🐴"), ("bee", "🐝"), ("butterfly", "🦋"), ("snail", "🐌"), ("snake", "🐍"),
    ("turtle", "🐢"), ("octopus", "🐙"), ("fish", "🐟"), ("dolphin", "🐬"), ("whale", "🐳"), ("shark", "🦈"),
    ("crab", "🦀"), ("goat", "🐐"), ("sloth", "🦥"), ("elephant", "🐘"), ("giraffe", "🦒"), ("dinosaur", "🦖"), ("t rex", "🦖"),
    ("dragon", "🐉"), ("spider", "🕷️"), ("duck", "🦆"), ("eagle", "🦅"), ("paw prints", "🐾"), ("paws", "🐾"),
    // — food / drink —
    ("pizza", "🍕"), ("burger", "🍔"), ("hamburger", "🍔"), ("fries", "🍟"), ("hot dog", "🌭"), ("taco", "🌮"),
    ("burrito", "🌯"), ("popcorn", "🍿"), ("sushi", "🍣"), ("ramen", "🍜"), ("noodles", "🍜"), ("rice", "🍚"),
    ("curry", "🍛"), ("bread", "🍞"), ("croissant", "🥐"), ("egg", "🥚"), ("cookie", "🍪"), ("donut", "🍩"),
    ("doughnut", "🍩"), ("ice cream", "🍦"), ("chocolate", "🍫"), ("candy", "🍬"), ("lollipop", "🍭"),
    ("apple", "🍎"), ("banana", "🍌"), ("strawberry", "🍓"), ("grapes", "🍇"), ("watermelon", "🍉"),
    ("peach", "🍑"), ("cherry", "🍒"), ("cherries", "🍒"), ("lemon", "🍋"), ("orange", "🍊"), ("mango", "🥭"),
    ("pineapple", "🍍"), ("avocado", "🥑"), ("eggplant", "🍆"), ("carrot", "🥕"), ("corn", "🌽"), ("pepper", "🌶️"),
    ("hot pepper", "🌶️"), ("chili", "🌶️"), ("cheese", "🧀"), ("salad", "🥗"),
    ("coffee", "☕"), ("tea", "🍵"), ("beer", "🍺"), ("beers", "🍻"), ("cheers", "🥂"), ("wine", "🍷"),
    ("cocktail", "🍸"), ("champagne", "🍾"), ("milk", "🥛"), ("boba", "🧋"), ("bubble tea", "🧋"),
    // — activity / travel / places —
    ("soccer", "⚽"), ("football", "🏈"), ("soccer ball", "⚽"), ("basketball", "🏀"), ("baseball", "⚾"),
    ("tennis", "🎾"), ("cricket", "🏏"), ("running", "🏃"), ("runner", "🏃"), ("dancing", "💃"), ("dancer", "💃"),
    ("car", "🚗"), ("taxi", "🚕"), ("bus", "🚌"), ("train", "🚆"), ("plane", "✈️"), ("airplane", "✈️"),
    ("bike", "🚲"), ("bicycle", "🚲"), ("ship", "🚢"), ("boat", "⛵"), ("house", "🏠"), ("home", "🏠"),
    ("office", "🏢"), ("school", "🏫"), ("hospital", "🏥"), ("tent", "⛺"), ("beach", "🏖️"), ("island", "🏝️"),
    ("crystal ball", "🔮"), ("magic", "🪄"), ("magic wand", "🪄"), ("candle", "🕯️"), ("pumpkin", "🎃"),
    ("jack o lantern", "🎃"), ("santa", "🎅"), ("baby", "👶"), ("ninja", "🥷"), ("detective", "🕵️"),
    ("superhero", "🦸"), ("zombie", "🧟"), ("mermaid", "🧜"), ("fairy", "🧚"), ("vampire", "🧛"),
    ("flexed biceps", "💪"), ("thumbs", "👍"),
];

static LOOKUP: Lazy<HashMap<&'static str, &'static str>> =
    Lazy::new(|| EMOJI_NAMES.iter().copied().collect());

// The word "emoji" itself. The name is read from the words before it, see below.
static EMOJI_WORD_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\bemojis?\b").unwrap());

fn is_name_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '\'' | '’' | '-')
}

fn normalize(word: &str) -> String {
    word.to_lowercase()
        .replace(['\'', '’'], "")
        .replace('-', " ")
}

/// Find the emoji named by the words at the end of `before`. Returns the byte offset
/// where the name starts and the emoji. Only plain words separated by spaces or tabs
/// count, so a comma, full stop, newline or an earlier emoji ends the search.
fn name_before(before: &str) -> Option<(usize, &'static str)> {
    let mut end = before.trim_end_matches([' ', '\t']).len();
    if end == before.len() {
        return None; // nothing before "emoji", or no space between them
    }
    // Up to MAX_NAME_WORDS (start, word) pairs, walking backwards.
    let mut words: Vec<(usize, &str)> = Vec::new();
    while words.len() < MAX_NAME_WORDS && end > 0 {
        let start = before[..end]
            .char_indices()
            .rev()
            .take_while(|&(_, c)| is_name_char(c))
            .last()
            .map(|(i, _)| i);
        let Some(start) = start else { break };
        words.push((start, &before[start..end]));
        let trimmed = before[..start].trim_end_matches([' ', '\t']);
        if trimmed.len() == start {
            break; // not separated by plain whitespace: the run ends here
        }
        end = trimmed.len();
    }
    words.reverse();
    // Longest name first, so "thumbs up" is preferred over "up".
    for i in 0..words.len() {
        let name = words[i..]
            .iter()
            .map(|(_, w)| normalize(w))
            .collect::<Vec<_>>()
            .join(" ");
        let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
        if let Some(emoji) = LOOKUP.get(name.as_str()) {
            return Some((words[i].0, emoji));
        }
    }
    None
}

/// Replace "<name> emoji" with the emoji itself. Words before the name are kept, and an
/// unknown name is left exactly as spoken.
pub fn apply_spoken_emoji(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last = 0;
    for m in EMOJI_WORD_RE.find_iter(input) {
        let before = &input[last..m.start()];
        match name_before(before) {
            Some((start, emoji)) => {
                out.push_str(&before[..start]);
                out.push_str(emoji);
            }
            None => out.push_str(&input[last..m.end()]),
        }
        last = m.end();
    }
    out.push_str(&input[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::apply_spoken_emoji;

    #[test]
    fn named_emoji_replaces_the_phrase() {
        assert_eq!(apply_spoken_emoji("that's so funny laughing emoji"), "that's so funny 😂");
        assert_eq!(apply_spoken_emoji("Laughing emoji"), "😂");
        assert_eq!(apply_spoken_emoji("great job, fire emoji."), "great job, 🔥.");
    }

    #[test]
    fn longest_name_wins() {
        assert_eq!(apply_spoken_emoji("nice thumbs up emoji"), "nice 👍");
        assert_eq!(apply_spoken_emoji("send heart eyes emoji now"), "send 😍 now");
        assert_eq!(apply_spoken_emoji("Thumbs-up emoji"), "👍");
    }

    #[test]
    fn plural_and_case_are_accepted() {
        assert_eq!(apply_spoken_emoji("love it Heart Emojis"), "love it ❤️");
    }

    #[test]
    fn unknown_names_and_plain_prose_are_untouched() {
        assert_eq!(apply_spoken_emoji("send me an emoji"), "send me an emoji");
        assert_eq!(apply_spoken_emoji("the flurbo emoji"), "the flurbo emoji");
        assert_eq!(apply_spoken_emoji("I was laughing so hard"), "I was laughing so hard");
    }

    #[test]
    fn several_in_one_dictation() {
        assert_eq!(
            apply_spoken_emoji("happy birthday party emoji cake emoji"),
            "happy birthday 🎉 🍰"
        );
    }
}
