# Image input

Image input accepts static PNG, JPEG and WebP files through the existing
`@relative/path` and `@"space path"` syntax. Absolute paths, secrets,
symlinks, hardlinks and special files remain denied. Intake validates the
extension, signature, format and full decode; original bytes are preserved.
Animated, malformed, truncated and mismatched files are rejected.

The fixed image limits are:

| Limit                                        |                               Value |
| -------------------------------------------- | ----------------------------------: |
| Encoded file size                            |           5,000,000 bytes per image |
| Width and height                             |               2,048 pixels per side |
| Decoded pixels                               |                 4,194,304 per image |
| Unique images                                |          8 per conversation/request |
| Total encoded image bytes                    | 20,000,000 per conversation/request |
| Image occurrences in inspected model history |                                   8 |
| Total occurrence bytes in inspected history  |                          20,000,000 |

These image bounds are independent of `maxFileBytes`. Images are copied to
immutable, content-addressed blobs under the private `paths.home/images`
directory (directories mode `0700`, files mode `0600`). Reads verify both the
stored hash and image metadata. Conversation and run state, queues, objectives,
and ordinary events contain references and metadata, never image payloads.
Image references remain available after the source file is moved or deleted,
through queue persistence and conversation handoff. Removing a run does not
remove its conversation's image blobs.

Back up `images/` together with the application data if image references must
survive restoration. Pi's private native session history can include image
bytes as canonical provider history; it is the only persistent model-history
copy. Do not share that history or application backups as ordinary logs.

Every eligible role and fallback must use a model explicitly configured with
`models.<alias>.images: true`; missing configuration means false. Pi also
checks that the SDK model accepts image input. The application does not OCR,
drop, resize or recompress images. It checks connection authorization before
dispatch and requires a fresh preview if configuration or disclosure changes.
Use `/images` to inspect retained image references in the current conversation.
Live-provider image acceptance has not been tested.

The request guard excludes image base64 from text-context byte accounting and
adds 24,576 bytes (8,192 tokens-equivalent) for each image occurrence in model
history, including repeated occurrences. This is a conservative estimate,
**not a guaranteed upper bound or exact usage for every provider**, and does
not prove provider context fit. Provider usage remains authoritative. Existing
`maxInputBytes`, model context and budget checks apply to the combined
estimate. History inspection decodes unique image bytes once where possible,
but charges and bounds every occurrence before dispatch.

Attached images are untrusted evidence, never instructions or permission.
`imageReferences` maps stable IDs, names and order to image inputs. Refer to
these IDs when comparing images.
