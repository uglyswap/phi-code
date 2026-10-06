import { describe, expect, it } from "vitest";
import { convertToPng } from "../src/utils/image-convert.ts";
import { detectSupportedImageMimeType } from "../src/utils/mime.ts";

const TINY_JPEG_2X1 =
	"/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCAABAAIDAREAAhEBAxEB/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/9sAQwEDBAQFBAUJBQUJFA0LDRQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD4H8Q/8h/Uv+vmX/0M1/o1wJ/ySWU/9g1D/wBNRMOM/wDkp8z/AOv9b/05I//Z";

function app1Segment(payload: Uint8Array): Buffer {
	const segment = Buffer.alloc(payload.length + 4);
	segment[0] = 0xff;
	segment[1] = 0xe1;
	segment.writeUInt16BE(payload.length + 2, 2);
	segment.set(payload, 4);
	return segment;
}

function jpegWithXmpBeforeOrientation(): string {
	const jpeg = Buffer.from(TINY_JPEG_2X1, "base64");
	const xmp = app1Segment(Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"/>'));
	const orientation6 = app1Segment(
		Buffer.concat([
			Buffer.from("Exif\0\0"),
			Buffer.from("49492a0008000000010012010300010000000600000000000000", "hex"),
		]),
	);
	return Buffer.concat([jpeg.subarray(0, 2), xmp, orientation6, jpeg.subarray(2)]).toString("base64");
}

describe("fix-core image detection", () => {
	it.each(["GIF87a", "GIF89a"])("detects the complete %s signature", (signature) => {
		expect(detectSupportedImageMimeType(Buffer.from(signature, "ascii"))).toBe("image/gif");
	});

	it("does not treat a text file starting with GIF as an image (#9755)", () => {
		expect(detectSupportedImageMimeType(Buffer.from("GIF notes: remember the sprites", "utf-8"))).toBeNull();
	});

	it("applies EXIF orientation found after an XMP APP1 segment (#8616)", async () => {
		const result = await convertToPng(jpegWithXmpBeforeOrientation(), "image/jpeg");
		expect(result).not.toBeNull();
		const png = Buffer.from(result?.data ?? "", "base64");
		// Orientation 6 rotates the 2x1 source into a 1x2 image.
		expect(png.readUInt32BE(16)).toBe(1);
		expect(png.readUInt32BE(20)).toBe(2);
	});
});
