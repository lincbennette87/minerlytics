function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents || "{}");
    var eventName = data.event || "unknown_event";
    var occurredAt = data.occurred_at || "";
    var user = data.user || {};

    var subject = "New Minerlytics Signup";
    var body =
      "A new user signed up for Minerlytics.\n\n" +
      "Event: " + eventName + "\n" +
      "Time: " + occurredAt + "\n" +
      "Name: " + (user.display_name || "") + "\n" +
      "First Name: " + (user.first_name || "") + "\n" +
      "Last Name: " + (user.last_name || "") + "\n" +
      "Email: " + (user.email || "") + "\n" +
      "User ID: " + (user.id || "") + "\n";

    MailApp.sendEmail(Session.getActiveUser().getEmail(), subject, body);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
