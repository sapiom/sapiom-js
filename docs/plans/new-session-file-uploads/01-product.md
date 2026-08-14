# Product: New-session file uploads

## Problem

When someone is describing a new agent, important context often already exists in screenshots, documents, data files, or examples on their computer. The create-new screen only accepts typed text today, forcing them to start a session first and then add the files again. This makes the first request incomplete and makes Studio feel less capable precisely at the moment a user is explaining what they want to build.

## Success metric

At least 95% of new-agent starts that include files deliver every selected file with the user's first request, measured from attachment selection through receipt by the agent.

## Announcement — the blog post before the feature

You can now give a new agent the files it needs before starting the session. Paste an image or copied file directly into the create-new composer, drop files from Finder, or choose them with the attachment button. Ordinary copied text still pastes into the description normally. Selected files stay visible and removable so you always know what will be sent. When you start the session, the agent receives your description and every attached file together as its first request.

## Screens

- `mockups/new-session-with-files.html` — the create-new composer with clipboard paste, an attachment button, selected-file tray, remove actions, and a full-composer drag target.
