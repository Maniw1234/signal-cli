package org.asamk.signal.manager.util;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;

class DataURITest {

    @Test
    void parsesSingleParameter() {
        final var uri = DataURI.of("data:image/png;filename=a.png;base64,AAAA");

        assertEquals("image/png", uri.mediaType());
        assertEquals(Map.of("filename", "a.png"), uri.parameter());
        assertArrayEquals(new byte[]{0, 0, 0}, uri.data());
    }

    @Test
    void parsesEachOfMultipleParameters() {
        final var uri = DataURI.of("data:audio/aac;filename=a.aac;charset=x;base64,AAAA");

        assertEquals("audio/aac", uri.mediaType());
        assertEquals(Map.of("filename", "a.aac", "charset", "x"), uri.parameter());
    }

    @Test
    void decodesUrlEscapedParameterValues() {
        final var uri = DataURI.of("data:text/plain;filename=my%20file.txt,hello");

        assertEquals(Map.of("filename", "my file.txt"), uri.parameter());
        assertArrayEquals("hello".getBytes(StandardCharsets.UTF_8), uri.data());
    }
}
