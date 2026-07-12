import colorsys
import io
import subprocess
import tempfile
from pathlib import Path

import boto3
import fitz  # PyMuPDF
import imageio_ffmpeg
from flask import current_app
from PIL import Image

from models import Book


def _s3_client():
    return boto3.client(
        "s3",
        aws_access_key_id=current_app.config["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=current_app.config["AWS_SECRET_ACCESS_KEY"],
        region_name=current_app.config["S3_REGION"],
    )


def _prefixed(key):
    return f"{current_app.config['S3_PREFIX']}/{key}"


def put_bytes(key, data, content_type):
    _s3_client().put_object(
        Bucket=current_app.config["S3_BUCKET"],
        Key=_prefixed(key),
        Body=data,
        ContentType=content_type,
    )


def delete_objects(keys):
    """Delete up to 1000 keys in a single batch call. No-op for an empty list."""
    if not keys:
        return
    client = _s3_client()
    objects = [{"Key": _prefixed(key)} for key in keys]
    for i in range(0, len(objects), 1000):
        client.delete_objects(
            Bucket=current_app.config["S3_BUCKET"],
            Delete={"Objects": objects[i : i + 1000]},
        )


def presign_get(key, ttl=None):
    ttl = ttl or current_app.config["PRESIGN_TTL_SECONDS"]
    return _s3_client().generate_presigned_url(
        "get_object",
        Params={"Bucket": current_app.config["S3_BUCKET"], "Key": _prefixed(key)},
        ExpiresIn=ttl,
    )


def render_pdf_pages(pdf_bytes, dpi=150):
    """Yield (page_number, webp_bytes) for every page in the PDF, 1-indexed."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        zoom = dpi / 72
        matrix = fitz.Matrix(zoom, zoom)
        for index, page in enumerate(doc):
            pix = page.get_pixmap(matrix=matrix)
            image = Image.open(io.BytesIO(pix.tobytes("png")))
            buffer = io.BytesIO()
            image.save(buffer, format="WEBP", quality=85)
            yield index + 1, buffer.getvalue()
    finally:
        doc.close()


def detect_theme_color(image_bytes):
    """Pick the nearest Book.THEME_SWATCHES key to an image's dominant color.

    Quantizes down to a handful of color clusters, drops the paper background
    (near-white/near-black/gray) and any tiny/noise clusters, then picks the
    most *saturated* of what's left. Frequency alone tends to pick cartoon
    outline/linework strokes -- often a saturated brown -- over the actual
    character/artwork color a human would call "the cover's color".
    """
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    image = image.resize((80, 80))
    quantized = image.quantize(colors=6, method=Image.MEDIANCUT)
    palette = quantized.getpalette()
    clusters = quantized.getcolors()  # (count, palette_index)
    total_pixels = sum(count for count, _ in clusters)

    def cluster_rgb(index):
        return tuple(palette[index * 3 : index * 3 + 3])

    def saturation(rgb):
        r, g, b = rgb
        return 0 if max(r, g, b) == 0 else (max(r, g, b) - min(r, g, b)) / max(r, g, b)

    def is_muted(rgb):
        s = saturation(rgb)
        brightness = max(rgb) / 255
        near_white = brightness > 0.92 and s < 0.35  # a pale pastel, not a vivid bright color
        near_black = brightness < 0.12
        grayish = s < 0.15
        return near_white or near_black or grayish

    significant = [cluster_rgb(idx) for count, idx in clusters if count / total_pixels > 0.05]
    vivid = [rgb for rgb in significant if not is_muted(rgb)]

    if not vivid:
        return "coral"  # no clear color signal in the page; keep the app's original default

    dominant = max(vivid, key=saturation)
    return _nearest_theme_key(dominant)


def _nearest_theme_key(rgb):
    # Hue is the primary signal (separates red/green/blue/purple families), but
    # brown sits at nearly the same hue as orange/coral -- it's really just a
    # dark, muted orange. Folding brightness into the distance lets a dedicated
    # "chestnut" swatch win for dark earthy tones (fur, wood, dirt) while bright
    # vivid oranges still land on "coral".
    target_hue, _, target_value = colorsys.rgb_to_hsv(*(c / 255 for c in rgb))

    def distance(key):
        base_hex = Book.THEME_SWATCHES[key]["base"]
        base_rgb = tuple(int(base_hex[i : i + 2], 16) / 255 for i in (1, 3, 5))
        base_hue, _, base_value = colorsys.rgb_to_hsv(*base_rgb)
        hue_diff = abs(target_hue - base_hue)
        hue_diff = min(hue_diff, 1 - hue_diff)
        value_diff = abs(target_value - base_value)
        return hue_diff * 1.5 + value_diff * 0.5

    return min(Book.THEME_CHOICES, key=distance)


def _split_concatenated_mp4(data):
    """iOS Safari's MediaRecorder can emit several independent, complete MP4 files
    over one recording session (each with its own ftyp/moov/mdat) instead of one
    continuous stream. The browser naively concatenates these into a single Blob,
    but ffmpeg's demuxer only reads the first embedded file and silently drops the
    rest. Split on every embedded ftyp box so each segment can be decoded on its own.
    """
    marker = b"ftyp"
    starts = []
    idx = data.find(marker)
    while idx != -1:
        starts.append(idx - 4)  # the 4-byte box size field precedes the type
        idx = data.find(marker, idx + 1)

    if len(starts) <= 1:
        return [data]

    boundaries = starts + [len(data)]
    return [data[boundaries[i] : boundaries[i + 1]] for i in range(len(starts))]


def transcode_to_mp3(input_bytes, debug_context=""):
    """Transcode an arbitrary browser-recorded audio blob to MP3.

    Returns (mp3_bytes, duration_ms).
    """
    logger = current_app.logger
    ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
    is_mp4_like = input_bytes[4:8] == b"ftyp"
    segments = _split_concatenated_mp4(input_bytes) if is_mp4_like else [input_bytes]

    logger.info(
        "[transcode %s] input_size=%d header=%s is_mp4_like=%s segments=%d segment_sizes=%s",
        debug_context, len(input_bytes), input_bytes[:16].hex(), is_mp4_like,
        len(segments), [len(s) for s in segments],
    )

    with tempfile.TemporaryDirectory() as tmpdir:
        out_path = Path(tmpdir) / "output.mp3"

        if len(segments) == 1:
            in_path = Path(tmpdir) / "input.blob"
            in_path.write_bytes(segments[0])
            _run_transcode(ffmpeg_path, in_path, out_path, debug_context, logger)
        else:
            wav_paths = []
            for i, segment in enumerate(segments):
                seg_path = Path(tmpdir) / f"segment{i}.blob"
                seg_path.write_bytes(segment)
                wav_path = Path(tmpdir) / f"segment{i}.wav"
                try:
                    result = subprocess.run(
                        [ffmpeg_path, "-y", "-i", str(seg_path), str(wav_path)],
                        check=True,
                        capture_output=True,
                    )
                except subprocess.CalledProcessError as e:
                    logger.warning(
                        "[transcode %s] segment %d decode failed: %s",
                        debug_context, i, e.stderr.decode(errors="replace"),
                    )
                    raise
                seg_duration = _probe_duration_ms(ffmpeg_path, wav_path)
                logger.info(
                    "[transcode %s] segment %d decoded duration_ms=%s stderr_tail=%s",
                    debug_context, i, seg_duration, result.stderr.decode(errors="replace")[-500:],
                )
                wav_paths.append(wav_path)

            concat_list = Path(tmpdir) / "concat.txt"
            concat_list.write_text("".join(f"file '{p.name}'\n" for p in wav_paths))
            subprocess.run(
                [
                    ffmpeg_path, "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list),
                    "-codec:a", "libmp3lame", "-qscale:a", "2", str(out_path),
                ],
                check=True,
                capture_output=True,
                cwd=tmpdir,
            )

        duration_ms = _probe_duration_ms(ffmpeg_path, out_path)
        output_bytes = out_path.read_bytes()
        logger.info(
            "[transcode %s] final duration_ms=%s output_bytes=%d",
            debug_context, duration_ms, len(output_bytes),
        )
        return output_bytes, duration_ms


def _run_transcode(ffmpeg_path, in_path, out_path, debug_context, logger):
    try:
        result = subprocess.run(
            [ffmpeg_path, "-y", "-i", str(in_path), "-codec:a", "libmp3lame", "-qscale:a", "2", str(out_path)],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as e:
        logger.warning("[transcode %s] direct transcode failed: %s", debug_context, e.stderr.decode(errors="replace"))
        raise
    logger.info(
        "[transcode %s] direct transcode stderr_tail=%s",
        debug_context, result.stderr.decode(errors="replace")[-500:],
    )


def _probe_duration_ms(ffmpeg_path, path):
    # imageio-ffmpeg only bundles ffmpeg, not ffprobe, so parse ffmpeg's own stderr.
    result = subprocess.run(
        [ffmpeg_path, "-i", str(path)],
        capture_output=True,
        text=True,
    )
    for line in result.stderr.splitlines():
        line = line.strip()
        if line.startswith("Duration:"):
            timestamp = line.split(",")[0].replace("Duration:", "").strip()
            hours, minutes, seconds = timestamp.split(":")
            total_seconds = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
            return int(total_seconds * 1000)
    return None
